// Explorer sky, in local km (+Y up). The parent of earth/sun must have an identity transform.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { createEarthRenderer } from './earth-render.js';
import { CameraFX, createSun, EYE_STARS } from './camera-fx.js';

const BODY_DISTANCE = 1400, AU_KM = 149597870.7;
// EV here is log2(radiance multiplier), not photographic EV100. No artificial night gain.
export const APP_EXPOSURE = Object.freeze({ key: .035, slope: .72, coverage: .12, bias: .6,
  minEV: -1.5, maxEV: 11, tauBright: .35, tauDark: 1, saturation: 2, clip: 12 });
const VERT = 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';
const quadMaterial = options => new THREE.ShaderMaterial({ vertexShader: VERT, depthTest: false, depthWrite: false, toneMapped: false, ...options });
const target = (w, h, depthBuffer = false) => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer, generateMipmaps: false });

// Two separable five-tap filters at HALF resolution; avoid UnrealBloom's five mip levels and full-screen copies.
class HalfBloom extends Pass {
  constructor() {
    super(); this.needsSwap = false; this.a = target(1, 1); this.b = target(1, 1);
    this.material = quadMaterial({ uniforms: { t: { value: null }, stepUv: { value: new THREE.Vector2() }, extract: { value: 1 } },
      fragmentShader: /* glsl */`
        uniform sampler2D t; uniform vec2 stepUv; uniform float extract; varying vec2 vUv;
        vec3 tap(vec2 uv) {
          vec3 c = clamp(texture2D(t, uv).rgb, 0., 24.);
          float l = max(c.r, max(c.g, c.b));
          return c * mix(1., max(l - 1., 0.) / max(l, 1e-4), extract);
        }
        void main() {
          vec3 c = tap(vUv) * .38774;
          c += (tap(vUv + stepUv * 1.3846) + tap(vUv - stepUv * 1.3846)) * .24477;
          c += (tap(vUv + stepUv * 3.2308) + tap(vUv - stepUv * 3.2308)) * .06136;
          gl_FragColor = vec4(c, 1.);
        }` });
    this.quad = new FullScreenQuad(this.material);
  }
  setSize(w, h) { this.a.setSize(Math.max(1, Math.ceil(w / 2)), Math.max(1, Math.ceil(h / 2))); this.b.setSize(this.a.width, this.a.height); }
  render(renderer, write, read) {
    const u = this.material.uniforms; u.t.value = read.texture; u.extract.value = 1; u.stepUv.value.set(1 / this.a.width, 0);
    renderer.setRenderTarget(this.a); this.quad.render(renderer);
    u.t.value = this.a.texture; u.extract.value = 0; u.stepUv.value.set(0, 1 / this.a.height);
    renderer.setRenderTarget(this.b); this.quad.render(renderer);
  }
  dispose() { this.a.dispose(); this.b.dispose(); this.material.dispose(); this.quad.dispose(); }
}

// ACES + sRGB + grain in ONE canvas pass (a separate OutputPass would add another full-frame read/write).
const FILM = {
  uniforms: { tDiffuse: { value: null }, tBloom: { value: null }, tState: { value: null }, toneMappingExposure: { value: 1 }, uTime: { value: 0 }, uGrain: { value: .006 }, uBloom: { value: .22 } },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tBloom, tState; uniform float uTime, uGrain, uBloom; varying vec2 vUv;
    #include <tonemapping_pars_fragment>
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 c = clamp(texture2D(tDiffuse, vUv).rgb + uBloom * texture2D(tBloom, vUv).rgb, 0., 48.);
      c = sRGBTransferOETF(vec4(ACESFilmicToneMapping(c), 1.)).rgb;
      float ev = max(texture2D(tState, vec2(.5)).r, 0.);
      // Shadow frames have higher sensor gain. Multiplicative grain leaves empty space black.
      float n = hash(gl_FragCoord.xy + floor(uTime * 24.) * vec2(31.7, 17.3)) - .5;
      c += n * uGrain * (1. + .32 * ev) * sqrt(clamp(c, 0., 1.));
      gl_FragColor = vec4(clamp(c, 0., 1.), 1.);
    }`
};

export class AppSky {
  constructor(renderer, scene, camera, { lowPower = false, assetUrl = path => new URL(path, import.meta.url).href, invalidate = () => {}, maxPixelRatio = 1 } = {}) {
    this.renderer = renderer; this.scene = scene; this.camera = camera; this.assetUrl = assetUrl; this.invalidate = invalidate;
    this.lowPower = lowPower; this.maxPixelRatio = Math.max(.5, maxPixelRatio); this.view = 'terrain'; this.disposed = false;
    this._dirty = true; this._lastMotion = performance.now(); this._pose = new Float64Array(32).fill(NaN);
    this._textures = new Set(); this._uploads = []; this._pending = 0; this._abort = new AbortController(); this.errors = [];
    this._centre = new THREE.Vector3(); this._sunDir = new THREE.Vector3(0, .02, -1).normalize();
    this._worldSun = new THREE.Vector3(); this._worldQ = new THREE.Quaternion();
    this._saved = { toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure };
    const half = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
    this.hdr = !lowPower && half;
    this.capable8k = !lowPower && renderer.capabilities.maxTextureSize >= 8192 && (navigator.deviceMemory || 0) >= 8 && matchMedia('(pointer:fine)').matches;
    this.earth = new THREE.Group(); this.earth.name = 'app-earth';
    const day = this._solid([30, 55, 65, 255], true), night = this._solid([0, 0, 0, 255], true), brc = this._solid([128, 255, 0, 255]);
    const log = Boolean(renderer.capabilities.logarithmicDepthBuffer);
    if (half) {
      this.earthRenderer = createEarthRenderer(renderer, { day, night, brc, physicalNight: true, logarithmicDepthBuffer: log });
      this.earth.add(this.earthRenderer.earth, this.earthRenderer.atmosphere);
      // The fallback draws straight to the canvas; the HDR path leaves scene radiance linear.
      if (!this.hdr) for (const m of [this.earthRenderer.earth.material, ...this.earthRenderer.atmosphere.children.map(o => o.material)]) {
        m.onBeforeCompile = shader => { shader.fragmentShader = shader.fragmentShader.replace(/}\s*$/, '#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}'); };
      }
    } else {
      this._fallbackEarth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), new THREE.MeshStandardMaterial({ map: day, roughness: .75 }));
      this.earth.add(this._fallbackEarth);
    }
    if (this.hdr) {
      this.fx = new CameraFX(renderer, { camera, initialEV: 0, sunOptions: { logarithmicDepthBuffer: log } });
      Object.assign(this.fx.params, APP_EXPOSURE, EYE_STARS, { milkyWay: 0, flare: .65, glare: 1, spikes: .65, ghosts: .25, halo: .12, veil: .025 });
      this.sun = this.fx.sun;
      // Geometry stays single-sampled: MSAA HDR targets multiply every post-pass bandwidth on ANGLE/iGPUs.
      this.composer = new EffectComposer(renderer, target(1, 1, true)); this.composer.setPixelRatio(1);
      this.stage = new Pass(); this.stage.needsSwap = false;
      this.stage.render = (r, write, read) => { r.setRenderTarget(read); r.clear(); r.render(scene, camera); };
      this.bloom = new HalfBloom(); this.film = new ShaderPass(FILM); this.film.material.toneMapped = false;
      this.film.uniforms.tBloom.value = this.bloom.b.texture;
      for (const p of [this.stage, this.fx.pass, this.bloom, this.film]) this.composer.addPass(p);
    } else {
      this.sun = createSun({ logarithmicDepthBuffer: log });
    }
    this.fx?.setFixedExposure(1.3);   // starts in the terrain view (see setView)
    this.earth.visible = this.sun.visible = false;
    // Initial maps are modest; decode asynchronously, then upload at most one image per still frame.
    this.ready = Promise.all([this._load('earth-day.jpg', true), this._load('earth-night.jpg', true), this._load('earth-brc.jpg')])
      .then(([dayMap, nightMap, brcMap]) => {
        if (this.disposed) return;
        if (this.earthRenderer) this.earthRenderer.setMaps({ day: dayMap, night: nightMap, brc: brcMap });
        else this._fallbackEarth.material.map = dayMap;
        for (const t of [day, night, brc]) this._release(t);
        this._baseReady = true; this._touch();
      }).catch(error => { this._error(error); });
    const size = renderer.getSize(new THREE.Vector2()); this.resize(size.x, size.y, renderer.getPixelRatio());
  }

  _solid(rgba, srgb = false) {
    const t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true; this._textures.add(t); return t;
  }
  _touch() { if (this.disposed) return; this._dirty = true; this.fx?.touch(); this.invalidate(); }
  _error(error) { if (!this.disposed && error?.name !== 'AbortError') { this.errors.push(String(error)); console.warn('AppSky:', error); this._touch(); } }
  _release(t) { this._textures.delete(t); t.dispose(); t.image?.close?.(); }
  _load(file, srgb = false, single = false, still = false) {
    this._pending++;
    return this._decodeLoad(file, srgb, single, still).finally(() => { this._pending--; this._touch(); });
  }
  async _decodeLoad(file, srgb, single, still) {
    const response = await fetch(this.assetUrl(`./assets/mission/${file}`), { signal: this._abort.signal });
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    const blob = await response.blob();
    let image, bitmap = typeof createImageBitmap === 'function';
    if (bitmap) image = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    else image = await new Promise((ok, fail) => {
      const url = URL.createObjectURL(blob), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); ok(img); }; img.onerror = () => { URL.revokeObjectURL(url); fail(new Error(file)); }; img.src = url;
    });
    if (this.disposed) { image.close?.(); throw new DOMException('Disposed', 'AbortError'); }
    // A constrained GPU can still open globe view: let the driver accept a capped version of the 8k source.
    const limit = this.renderer.capabilities.maxTextureSize;
    if (image.width > limit || image.height > limit) {
      if (!bitmap) throw new Error(`${file}: exceeds MAX_TEXTURE_SIZE`);
      const scale = limit / Math.max(image.width, image.height), old = image;
      image = await createImageBitmap(old, { resizeWidth: Math.max(1, Math.floor(old.width * scale)), resizeHeight: Math.max(1, Math.floor(old.height * scale)) }); old.close();
    }
    if (this.disposed) { image.close?.(); throw new DOMException('Disposed', 'AbortError'); }
    const t = new THREE.Texture(image); t.flipY = !bitmap; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping; t.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    if (single) t.format = THREE.RedFormat; t.needsUpdate = true; this._textures.add(t);
    return new Promise((resolve, reject) => {
      this._uploads.push({ still, reject, run: () => { this.renderer.initTexture(t); resolve(t); } }); this._touch();
    });
  }

  // Optional registration keeps the existing stars.js orientation, while replacing its arbitrary brightness in HDR.
  setStars(catalog, points) { this.starField = points; this.fx?.setStars(catalog); this._touch(); }
  setMoon(mesh) { this.moon = mesh; if (this.view === 'globe') this._loadMoon(); }
  _loadMoon() {
    if (!this.moon || this._moonLoading) return; this._moonLoading = true;
    Promise.all([this._load(this.capable8k ? 'moon-color-8k.jpg' : 'moon-color.jpg', true, false, true), this._load('moon-normal.jpg', false, false, true)]).then(([map, normal]) => {
      if (this.disposed) return;
      // Image normal maps are north/+Y; the generated regolith map used -Y. Keep lunarMaterial's photometry.
      this.moon.material.map = map; this.moon.material.normalMap = normal;
      this.moon.material.normalScale.y = Math.abs(this.moon.material.normalScale.y);
      this.moon.material.needsUpdate = true; this._touch();
    }).catch(e => this._error(e));
  }
  _load8k() {
    if (this._hiLoading || !this._baseReady || !this.capable8k || !this.earthRenderer) return; this._hiLoading = true;
    // Keep the optional cloud/water variant alive before the first swap: ANGLE can compile it in parallel.
    const m = this.earthRenderer.earth.material;
    this._warm = new THREE.ShaderMaterial({ uniforms: m.uniforms, vertexShader: m.vertexShader, fragmentShader: m.fragmentShader, defines: { ...m.defines, CLOUD_MAP: '', WATER_MAP: '' } });
    const previous = this.renderer.getRenderTarget(); let compiled;
    try { this.renderer.setRenderTarget(this.composer?.readBuffer || null); compiled = this.renderer.compileAsync(new THREE.Mesh(this.earthRenderer.earth.geometry, this._warm), this.camera, this.scene); }
    catch (e) { compiled = Promise.reject(e); } finally { this.renderer.setRenderTarget(previous); }
    Promise.all([compiled, this._load('earth-day-8k.jpg', true, false, true), this._load('earth-night-8k.jpg', true, false, true),
      this._load('earth-clouds-8k.jpg', false, true, true), this._load('earth-water-8k.png', false, true, true)])
      .then(([, day, night, clouds, water]) => { this._hiMaps = { day, night, clouds, water, dayStyle: 'bmng' }; this._touch(); }).catch(e => this._error(e));
  }

  update(result, date, earthFrame = null) {
    this.result = result; this.date = date;
    this.earth.visible = this.sun.visible = true;
    this.earth.position.fromArray(result.earth.direction).multiplyScalar(BODY_DISTANCE);
    this._sunDir.fromArray(result.sun.direction).normalize(); this.sun.position.copy(this._sunDir).multiplyScalar(BODY_DISTANCE);
    if (earthFrame?.isMatrix4) this.earth.quaternion.setFromRotationMatrix(earthFrame);
    else if (earthFrame) this.earth.quaternion.copy(earthFrame);
    this.distanceAU = Math.max(.9, result.sun.distanceKm / AU_KM);
    this.kmPerUnit = Math.max(1, result.earth.distanceKm / BODY_DISTANCE);
    if (this._fallbackEarth) this._fallbackEarth.scale.setScalar(6371 / this.kmPerUnit);
    this._touch();
  }
  _cameraChanged(save = false) {
    this.camera.updateMatrixWorld();
    const arrays = [this.camera.matrixWorld.elements, this.camera.projectionMatrix.elements]; let changed = false, i = 0;
    for (const a of arrays) for (const x of a) { if (!(Math.abs(this._pose[i] - x) < 1e-9)) changed = true; if (save) this._pose[i] = x; i++; }
    return changed;
  }
  // The 3D relief view is a diagram: its rays, pins and paths are interface colours, so the camera keeps the old fixed
  // exposure there (x1.3); the surface view is a photograph and meters itself.
  setView(view) { if (view === this.view) return; this.view = view; this.fx?.setFixedExposure(view === 'terrain' ? 1.3 : null); if (view === 'globe') this._loadMoon(); this._touch(); }
  resize(w, h, pixelRatio = this.renderer.getPixelRatio()) {
    // Canvas can retain native DPI; HDR is capped at one pixel per CSS pixel by default (~1080p on the notebook).
    // scale: the adaptive resolution of the scene (1 = full).
    const r = Math.min(pixelRatio, this.maxPixelRatio * (this.scale || 1)); this.composer?.setSize(Math.max(1, Math.round(w * r)), Math.max(1, Math.round(h * r)));
    this._touch();
  }
  needsFrames() { return !this.disposed && (this._dirty || this._cameraChanged() || this._pending > 0 || this._uploads.length > 0 || (this.view !== 'globe' && Boolean(this.fx?.settling()))); }

  render(dt = 1 / 60) {
    if (this.disposed) return; this._dirty = false;
    const now = performance.now(); if (this._cameraChanged(true)) { this._lastMotion = now; this.fx?.touch(now); }
    const still = now - this._lastMotion > 600;
    const at = this._uploads.findIndex(u => !u.still || still);
    if (at >= 0) { const upload = this._uploads.splice(at, 1)[0]; try { upload.run(); } catch (e) { upload.reject(e); } this._touch(); }
    if (still && this.view !== 'globe' && this.camera.getEffectiveFOV() < 10) this._load8k();
    if (still && this._hiMaps && this.camera.getEffectiveFOV() < 10 && this.view !== 'globe') {
      const u = this.earthRenderer.uniforms, old = [u.uDay.value, u.uNight.value];
      this.earthRenderer.setMaps(this._hiMaps); this._hiMaps = null; for (const t of old) this._release(t); this._touch();
    }
    this.scene.updateMatrixWorld(); this.earth.getWorldPosition(this._centre);
    this._worldSun.copy(this._sunDir); if (this.sun.parent) this._worldSun.applyQuaternion(this.sun.parent.getWorldQuaternion(this._worldQ));
    if (this.earthRenderer && this.result && this.view !== 'globe') {
      this.earthRenderer.update(this.camera, this._centre, this._worldSun, this.kmPerUnit);
      // Renderer uses world centres; these proxy meshes live inside our labelled/oriented Earth group.
      this.earthRenderer.earth.position.set(0, 0, 0); this.earthRenderer.atmosphere.position.set(0, 0, 0);
    }
    const uSun = this.sun.material.uniforms; uSun.uSunDir.value.copy(this._worldSun); uSun.uRadius.value = Math.asin(695700 / ((this.distanceAU || 1) * AU_KM));
    const r = this.renderer, previous = r.getRenderTarget(), auto = r.autoClear, exposure = r.toneMappingExposure;
    const clearAlpha = r.getClearAlpha();
    const starsVisible = this.starField?.visible;
    try {
      if (this.hdr && this.view !== 'globe') {
        r.autoClear = false; r.setClearAlpha(0); r.toneMappingExposure = 1;
        if (this.starField) { this.starField.updateMatrixWorld(); this.fx.j2000ToScene.setFromMatrix4(this.starField.matrixWorld); this.starField.visible = false; }
        // HDR samples handle ridges at the CAMERA's height. Off-frame glare needs an explicit camera-horizon fraction:
        // site terrainFraction can be wrong after walking below a ridge, so the default outside the image is zero.
        const fraction = THREE.MathUtils.clamp(this.sunVisibilityOverride ?? this.result?.sun.terrainFraction ?? 0, 0, 1);
        const eclipse = 1 - (this.result?.sun.eclipse || 0);
        this.fx.update(this.camera, { sunDir: this._worldSun, distanceAU: this.distanceAU || 1, unitKm: 1,
          sunVisibility: this.sunVisibilityOverride == null ? eclipse : fraction * eclipse, offscreenVisibility: this.sunVisibilityOverride == null ? 0 : fraction });
        this.film.uniforms.tState.value = this.fx.state[1 - this.fx.current].texture;
        this.film.uniforms.uTime.value = now / 1000; this.composer.render(Math.min(.1, Math.max(0, dt)));
      } else {
        r.autoClear = true; r.toneMappingExposure = this._saved.exposure; r.setRenderTarget(null); r.render(this.scene, this.camera);
      }
    } finally {
      if (this.starField) this.starField.visible = starsVisible;
      r.setRenderTarget(previous); r.autoClear = auto; r.setClearAlpha(clearAlpha); r.toneMappingExposure = exposure;
    }
  }
  dispose() {
    this.disposed = true; this._abort.abort();
    for (const u of this._uploads) u.reject(new DOMException('Disposed', 'AbortError')); this._uploads.length = 0;
    this.earth.removeFromParent(); this.sun.removeFromParent(); this.earthRenderer?.dispose();
    this._fallbackEarth?.geometry.dispose(); this._fallbackEarth?.material.dispose();
    this.fx?.dispose(); if (!this.fx) { this.sun.geometry.dispose(); this.sun.material.dispose(); }
    this.bloom?.dispose(); this.film?.dispose(); this.composer?.dispose(); this._warm?.dispose();
    for (const t of [...this._textures]) this._release(t);
  }
}
