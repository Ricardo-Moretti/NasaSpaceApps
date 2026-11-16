import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RADIUS_KM, siteBasis, unit } from './model.js';
import { number } from './i18n.js';
// Short distances read in metres: a ridge 250 m away is not "0 km".
const distance = km => (km < 1 ? `${number(Math.round(km * 100) * 10)} m` : km < 10 ? `${number(km, 1)} km` : `${number(Math.round(km))} km`);
import { loadStarCatalog, createStarField, setRotationRows, combine } from './stars.js';
import { lunarMaterial, detailedTerrainGeometry, contextTerrainGeometry, innerTerrainGeometry, siteSpace, lunarSpace, earthshineUniforms, earthshineIrradiance, REGOLITH_UNIFORMS, loadRegolith } from './lunar-surface.js';
import { TerrainLight, NEAR_SHADOW } from './terrain-light.js';
import { LandingSite } from './landing-site.js';
import { loadNasaModels } from './nasa-models.js';
import { makeEnvironment, createMaterials, buildLM } from './spacecraft.js';
import { AppSky } from './app-sky.js';
import { buildLMCabin } from './lm-cabin.js';

const asset = path => new URL(path, import.meta.url).href;
const v3 = a => new THREE.Vector3(...a);
const bodyToScene = a => new THREE.Vector3(a[0], a[2], -a[1]);
export const SCENE_COLORS = { sun: 0xffe600, earth: 0xff5c9a, blocked: 0x8a8a82 };
const PATH_RADIUS = 1250, HORIZON_RADIUS = 1150, STAR_RADIUS = 1800;
const lowPower = () => matchMedia('(max-width: 820px)').matches || (navigator.hardwareConcurrency || 8) <= 4;
// Walking on the surface as a suited astronaut: Apollo crews walked at about 1 m/s and loped faster; the eyes sit at
// the observer height. The detailed ground (landing-site.js: craters down to ~15 cm, rocks) covers 800 × 800 m around
// the reference point, and the walk stays inside it.
// Lunar gravity, 1.62 m/s² (km/s² here). A jump in the suit: John Young's jump salute (Apollo 16) rose ~0.42 m and
// lasted ~1.45 s, i.e. 1.17 m/s at take-off. Running is the astronauts' lope: low hops of ~6 cm, ~0.55 s in the air.
const G_MOON = .00162, JUMP_V = .00117, HOP_V = .00045;
const WALK_SPEED = .0012, RUN_SPEED = .0025, WALK_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift']);
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// Monotone cubic through (xs, ys) (Fritsch–Carlson), at rest at both ends: smooth, without overshoot.
function smoothThrough(xs, ys) {
  const n = xs.length, h = [], d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); d.push((ys[i + 1] - ys[i]) / h[i]); }
  for (let i = 1; i < n - 1; i++) if (d[i - 1] * d[i] > 0) { const a = 2 * h[i] + h[i - 1], b = h[i] + 2 * h[i - 1]; m[i] = (a + b) / (a / d[i - 1] + b / d[i]); }
  return x => {
    if (x <= xs[0]) return ys[0]; if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}
// Ground path (x, z) from a to b round a disc (c, r): straight when it clears the disc, otherwise along the tangents and
// the arc between them, the shorter way round.
function roundPath(a, b, c, r) {
  const A = [a.x - c.x, a.z - c.z], B = [b.x - c.x, b.z - c.z], d = [B[0] - A[0], B[1] - A[1]];
  const s = THREE.MathUtils.clamp(-(A[0] * d[0] + A[1] * d[1]) / Math.max(d[0] * d[0] + d[1] * d[1], 1e-18), 0, 1);
  if (Math.hypot(A[0] + d[0] * s, A[1] + d[1] * s) >= r) return [a, b];
  const ang = p => Math.atan2(p[1], p[0]), wrap = x => Math.atan2(Math.sin(x), Math.cos(x));
  const side = Math.sign(wrap(ang(B) - ang(A))) || 1, t1 = ang(A) + side * Math.acos(Math.min(1, r / Math.max(Math.hypot(...A), r))), t2 = ang(B) - side * Math.acos(Math.min(1, r / Math.max(Math.hypot(...B), r)));
  let sweep = wrap(t2 - t1); if (sweep * side < 0) sweep = Math.abs(sweep) < .3 ? 0 : sweep + side * 2 * Math.PI; // (a graze: no lap)
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / .2)), out = [a];
  for (let i = 0; i <= n; i++) { const t = t1 + sweep * i / n; out.push({ x: c.x + Math.cos(t) * r, z: c.z + Math.sin(t) * r }); }
  out.push(b); return out;
}
const Y_UP = new THREE.Vector3(0, 1, 0);

function discTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.55, 'rgba(255,255,255,.9)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
// Straight sight line from the observer along a direction, checked against the same terrain
// the horizon uses. Returns the first point where the relief rises above the line.
function trace(terrain, dir, h0) {
  const horiz = Math.hypot(dir.x, dir.z);
  const reach = terrain.wide ? terrain.wide.extent / 2 - 5 : 50;
  if (horiz < 1e-6) return { blocked: false, distance: reach };
  const sx = dir.x / horiz, sz = dir.z / horiz, slope = dir.y / horiz;
  for (let d = 0.25; d <= reach; d += d < 50 ? 0.25 : 1) {
    const ground = terrain.heightAt(sx * d, sz * d);
    if (ground > h0 + d * slope) return { blocked: true, distance: d, point: new THREE.Vector3(sx * d, ground, sz * d) };
  }
  return { blocked: false, distance: reach };
}

// The same sight line from any point of the relief (the walker): fine steps over the first 500 m, then as trace().
function traceFrom(terrain, x0, z0, h0, dir) {
  const horiz = Math.hypot(dir.x, dir.z), reach = terrain.wide ? terrain.wide.extent / 2 - 5 : 50;
  if (horiz < 1e-6) return dir.y > 0;
  const sx = dir.x / horiz, sz = dir.z / horiz, slope = dir.y / horiz;
  for (let d = .01; d <= reach; d += d < .5 ? .01 : d < 50 ? .25 : 1) if (terrain.heightAt(x0 + sx * d, z0 + sz * d) > h0 + d * slope) return false;
  return true;
}

class SightRay {
  constructor(color, parent) {
    this.color = color;
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 12, 1, true), new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: 0.95, depthWrite: false }));
    this.shade = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: SCENE_COLORS.blocked, dashSize: 0.9, gapSize: 0.7, transparent: true, opacity: 0.85, toneMapped: false }));
    this.hit = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
    this.halo = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.1, 40), new THREE.MeshBasicMaterial({ color, toneMapped: false, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
    this.halo.renderOrder = 5;
    parent.add(this.beam, this.shade, this.hit, this.halo);
    this.state = null;
  }
  update(origin, direction, terrain, heightKm, length = 60) {
    const result = trace(terrain, direction, heightKm);
    const end = result.blocked ? result.point.clone() : origin.clone().addScaledVector(direction, length);
    const span = end.clone().sub(origin), len = span.length();
    this.beam.position.copy(origin).addScaledVector(span, 0.5);
    this.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), span.clone().normalize());
    this.length = len;
    this.hit.visible = this.halo.visible = this.shade.visible = result.blocked;
    if (result.blocked) {
      this.hit.position.copy(end); this.halo.position.copy(end);
      const beyond = Math.max(result.distance + 4, Math.min(length, result.distance * 1.6));
      this.shade.geometry.dispose();
      this.shade.geometry = new THREE.BufferGeometry().setFromPoints([end, origin.clone().addScaledVector(direction, beyond / Math.hypot(direction.x, direction.z))]);
      this.shade.computeLineDistances();
    }
    this.state = result;
    return result;
  }
  thickness(radius, camera) {
    this.beam.scale.set(radius, this.length, radius);
    this.hit.scale.setScalar(radius * 2.6);
    this.halo.scale.setScalar(radius * 2.6);
    this.halo.quaternion.copy(camera.quaternion);
    this.shade.material.dashSize = radius * 14; this.shade.material.gapSize = radius * 10;
  }
  set visible(v) { this.beam.visible = v; if (!v) { this.hit.visible = this.halo.visible = this.shade.visible = false; } else if (this.state) { this.hit.visible = this.halo.visible = this.shade.visible = this.state.blocked; } }
}

export class LunarScene {
  constructor(canvas, container, sites, onError, { t = (k) => k, onSite = null } = {}) {
    this.container = container; this.sites = sites; this.t = t; this.view = 'terrain'; this.dirty = true; this.disposed = false;
    this.lowPower = lowPower(); this.readingLight = false;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
    this.basePixelRatio = Math.min(window.devicePixelRatio, this.lowPower ? 1.5 : 2); this.resScale = 1; this.frameStats = { ema: 0, slow: 0, fast: 0, last: 0 };
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.3;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x000000);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.0005, 6000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false; this.controls.addEventListener('change', () => this.invalidate());

    // One nonnegative solar source. Relief visibility multiplies it; the tight map contains objects only.
    this.groundLight = new TerrainLight(this.renderer, { lowPower: this.lowPower });
    this.sunlight = new THREE.DirectionalLight(0xfff4e0, 3.1); this.sunlight.castShadow = true;
    const shadowSize = this.lowPower ? NEAR_SHADOW.lowSize : NEAR_SHADOW.size;
    this.sunlight.shadow.mapSize.set(shadowSize, shadowSize);
    Object.assign(this.sunlight.shadow.camera, { left: -NEAR_SHADOW.halfWidthKm, right: NEAR_SHADOW.halfWidthKm, top: NEAR_SHADOW.halfHeightKm, bottom: -NEAR_SHADOW.halfHeightKm, near: .05, far: 1.2 });
    // With the heightfield excluded as a caster, 6 mm receiver offset retains decimetre clast shadows.
    this.sunlight.shadow.normalBias = NEAR_SHADOW.normalBiasKm; this.sunlight.shadow.bias = NEAR_SHADOW.bias;
    this.sunlight.shadow.autoUpdate = false; this.sunlight.shadow.needsUpdate = true;
    this.scene.add(this.sunlight, this.sunlight.target);
    // Reading light (off by default): earthlight from Earth's direction plus a faint sky fill.
    // It exists only to read relief in shadow; it is not physical and the UI says so.
    this.earthlight = new THREE.DirectionalLight(0x9fc4ff, 0); this.scene.add(this.earthlight, this.earthlight.target);
    this.fill = new THREE.HemisphereLight(0xb9c7d8, 0x000000, 0); this.scene.add(this.fill);

    this.localGroup = new THREE.Group(); this.globeGroup = new THREE.Group(); this.overlay = new THREE.Group();
    this.scene.add(this.localGroup, this.globeGroup); this.localGroup.add(this.overlay);
    this.globeGroup.visible = false;

    const loader = new THREE.TextureLoader();
    this.moonTexture = loader.load(asset('./assets/moon-color.jpg'), () => this.invalidate(), undefined, () => onError(t('error.moonTexture')));
    this.moonTexture.colorSpace = THREE.SRGBColorSpace; this.moonTexture.wrapS = THREE.RepeatWrapping;
    this.moonTexture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.groundSpace = lunarSpace(); this.groundEarthshine = earthshineUniforms();
    loadRegolith(() => this.invalidate(), Math.min(16, this.renderer.capabilities.getMaxAnisotropy()));
    this.psrUniform = { value: 0 };
    const ground = { space: this.groundSpace, earthshine: this.groundEarthshine, grain: !this.lowPower };
    this.terrainMaterial = this.groundLight.attach(lunarMaterial({ ...ground, psr: this.psrUniform }));
    this.innerMaterial = this.groundLight.attach(lunarMaterial({ ...ground, psr: this.psrUniform }));
    this.contextMaterial = this.groundLight.attach(lunarMaterial(ground));

    // Earth and Sun: the mission's physical renderers (app-sky.js). The Earth has the Hillaire atmosphere, its real
    // phase and orientation (orientEarth: Greenwich sidereal time), clouds and sun glint; the Sun is the limb-darkened
    // disc at true size with the camera's glare. The surface and terrain views go through an HDR camera with automatic
    // exposure (CameraFX), as a photograph would: sunlit regolith is exposed like an Apollo frame, and a scene lit only
    // by earthshine opens up, dim and grainy. Low-power devices draw directly, as before.
    this.sky = new AppSky(this.renderer, this.scene, this.camera, { lowPower: this.lowPower, assetUrl: asset, invalidate: () => this.invalidate(), maxPixelRatio: 1 });
    this.earth = this.sky.earth; this.sun = this.sky.sun;
    this.localGroup.add(this.earth, this.sun);

    this.moon = new THREE.Mesh(new THREE.SphereGeometry(12, 192, 128), lunarMaterial({ vertexColors: false, map: this.moonTexture, color: 0xf2efe8 }));
    this.globeGroup.add(this.moon); this.sky.setMoon(this.moon);
    this.makeGraticule();
    this.globeMarkers = sites.map(site => {
      const marker = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
      marker.position.copy(bodyToScene(siteBasis(site).up).multiplyScalar(12.03)); marker.userData.siteId = site.id;
      this.globeGroup.add(marker); return marker;
    });
    this.siteLabels = sites.map((site, i) => {
      const el = document.createElement('div'); el.className = 'globe-site-label'; el.textContent = String(i + 1);
      el.setAttribute('aria-hidden', 'true'); container.append(el); return el;
    });
    // Compared sites, seen from the explored one: a pin on the relief, a label with the distance and a
    // faint line along the ground. All five points lie within 190 km of each other.
    this.onSite = onSite;
    this.sitePins = sites.map((site, i) => {
      const el = document.createElement('button'); el.type = 'button'; el.className = 'site-pin';
      el.innerHTML = `<b>${i + 1}</b><span></span><i></i><em aria-hidden="true"></em>`; el.addEventListener('click', () => this.onSite?.(site.id)); container.append(el);
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
      const link = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, toneMapped: false }));
      pin.visible = link.visible = false; this.overlay.add(pin, link);
      return { site, el, pin, link, base: new THREE.Vector3(), top: new THREE.Vector3(), km: 0, shown: false };
    });
    this.blockLabels = ['sun', 'earth'].map(body => {
      const el = document.createElement('div'); el.className = `block-label block-${body}`; el.setAttribute('aria-hidden', 'true');
      container.append(el); return el;
    });

    this.makeObserver();
    // Walking in the surface view: the walker, an invisible body for its shadow, the helmet and the controls.
    this.walker = { x: 0, z: 0, keys: new Set(), last: performance.now(), phase: 0, checked: 0, helmet: true, visor: false, run: false, here: null, lander: true, air: false, vy: 0, yoff: 0, vx: 0, vz: 0 };
    this.makeAstronaut(); this.makeHelmet(canvas); this.makeWalkHud(container);
    // Black over the scene for the cut on the way into the lunar module and the way out (the controls stay above it).
    this.fade = document.createElement('div'); this.fade.className = 'scene-fade'; this.fade.setAttribute('aria-hidden', 'true'); this.helmet.after(this.fade);
    this.onWalkKey = e => {
      if (this.disposed) return;
      const key = e.key.toLowerCase(), el = document.activeElement;
      if (e.type === 'keyup' && this.walker.keys.delete(key)) this.invalidate();
      if (this.view !== 'surface') return;
      if (key === ' ') {
        if (e.type !== 'keydown' || e.repeat || el?.closest?.('button, input, textarea, select, [contenteditable], .guide-card') || document.querySelector('dialog[open]')) return;
        e.preventDefault(); this.jump(); return;
      }
      if (!WALK_KEYS.has(key)) return;
      if (e.type === 'keydown' && (el?.closest?.('input, textarea, select, [contenteditable], .guide-card') || document.querySelector('dialog[open]'))) return;
      if (e.type === 'keydown') this.walker.keys.add(key); else this.walker.keys.delete(key);
      if (key !== 'shift') e.preventDefault();
      this.invalidate();
    };
    this.onWalkBlur = () => this.walker.keys.clear();
    window.addEventListener('keydown', this.onWalkKey); window.addEventListener('keyup', this.onWalkKey); window.addEventListener('blur', this.onWalkBlur);
    this.rays = { sun: new SightRay(SCENE_COLORS.sun, this.overlay), earth: new SightRay(SCENE_COLORS.earth, this.overlay) };
    this.paths = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true, map: discTexture(), transparent: true, depthWrite: false, toneMapped: false }));
    this.paths.frustumCulled = false; this.localGroup.add(this.paths);
    this.horizonLine = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthTest: false, toneMapped: false }));
    this.horizonLine.renderOrder = 4; this.localGroup.add(this.horizonLine);

    loadStarCatalog().then(data => {
      if (!data || this.disposed) return;
      this.stars = createStarField(data, STAR_RADIUS);
      this.stars.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
      this.scene.add(this.stars); this.sky.setStars(data, this.stars); this.orientStars(); this.invalidate();
    });

    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(container);
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.contextLost = true; onError(t('error.contextLost')); });
    canvas.addEventListener('webglcontextrestored', () => { this.contextLost = false; this.invalidate(); });
    // In the surface view the wheel works like a lens: it changes the field of view.
    canvas.addEventListener('wheel', e => { if (this.view !== 'surface') return; e.preventDefault(); this.setFov(this.camera.fov * Math.exp(e.deltaY * 0.0012)); }, { passive: false });
    canvas.addEventListener('keydown', e => {
      if (!this.terrain) return;
      if (e.key === 'Home') { this.resetCamera(); e.preventDefault(); }
      if (e.key.startsWith('Arrow') && this.view !== 'surface') {
        const offset = this.camera.position.clone().sub(this.controls.target);
        const angle = e.key === 'ArrowLeft' ? 0.08 : e.key === 'ArrowRight' ? -0.08 : 0;
        if (angle) offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
        else offset.multiplyScalar(e.key === 'ArrowUp' ? 0.9 : 1.1);
        this.camera.position.copy(this.controls.target).add(offset); this.controls.update(); e.preventDefault(); this.invalidate();
      }
    });
    this.render = () => {
      if (this.disposed) return;
      const now = performance.now(), dt = Math.min(.1, (now - this.walker.last) / 1000); this.walker.last = now;
      if (this.view === 'surface' && !this.walker.cabin && (this.walker.keys.size || this.walker.air) && !this.suspended) { this.walk(dt); this.dirty = true; }
      if (this.dirty && !this.suspended && !document.hidden && !this.contextLost) {
        if (this.cabinEntry) this.updateCabinEntry(dt);
        this.frameView(); this.controls.update(); this.updateThickness();
        // Cached horizon pass only on Sun/relief changes; walking redraws only the small-object map.
        const walking = this.view === 'surface' && Boolean(this.landing);
        if (walking) {
          this.landing.updateClasts(this.walker.x, this.walker.z, { lowPower: this.lowPower });
          this.placeNearLights(); this.sunlight.shadow.needsUpdate = true;
        }
        if (this.lander && !this.lander.userData.terrainLight) {
          this.lander.traverse(o => { if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) this.groundLight.attach(m); });
          this.lander.userData.terrainLight = true;
        }
        for (const mesh of [this.terrainMesh, this.innerMesh, this.contextMesh, this.landing?.mesh]) if (mesh) mesh.castShadow = false;
        // A sampled near map must be allocated on its first shadow-enabled frame.
        if (this.sunlight.castShadow && !this.sunlight.shadow.map) this.sunlight.shadow.needsUpdate = true;
        if (this.view !== 'globe') this.groundLight.update(this.camera);
        this.sky.render(dt); this.updateLabels(); this.dirty = this.sky.needsFrames() || Boolean(this.cabinEntry) || (this.view !== 'globe' && this.groundLight.pending());
        this.adaptResolution(now);
      }
      this.frame = requestAnimationFrame(this.render);
    };
    this.resize(); this.render();
  }

  makeObserver() {
    this.observer = new THREE.Group();
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.4, 2, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
    ring.rotation.x = -Math.PI / 2; ring.renderOrder = 5;
    this.observerPin = pin; this.observerRing = ring;
    this.observer.add(pin, ring); this.overlay.add(this.observer);
  }
  makeGraticule() {
    const material = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 });
    for (const lat of [-80, -85]) {
      const points = [];
      for (let lon = 0; lon <= 360; lon += 3) points.push(bodyToScene(siteBasis({ lat, lon }).up).multiplyScalar(12.015));
      this.globeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
    }
  }

  setTerrain(terrain) {
    if (this.terrain?.site.id === terrain.site.id && this.terrain.wide === terrain.wide && this.terrain.inner === terrain.inner) return;
    this.terrain = terrain;
    // siteSpace splits its translation into lattice cells; keep both parts for lunar detail/earthshine.
    const space = siteSpace(siteBasis(terrain.site), RADIUS_KM + terrain.elevationKm - terrain.height(0, 0));
    this.groundSpace.matrix.value.copy(space.matrix.value); this.groundSpace.cells.value.copy(space.cells.value);
    this.groundLight.setTerrain(terrain);
    for (const mesh of [this.terrainMesh, this.contextMesh]) if (mesh) { this.localGroup.remove(mesh); mesh.geometry.dispose(); }
    this.terrainMesh = new THREE.Mesh(detailedTerrainGeometry(terrain, { stride: this.lowPower ? 2 : 1 }), this.terrainMaterial);
    this.terrainMesh.castShadow = false; this.terrainMesh.receiveShadow = true;
    this.localGroup.add(this.terrainMesh);
    if (this.innerMesh) { this.localGroup.remove(this.innerMesh); this.innerMesh.geometry.dispose(); this.innerMesh = null; }
    const inner = innerTerrainGeometry(terrain, { stride: this.lowPower ? 2 : 1 });
    if (inner) { this.innerMesh = new THREE.Mesh(inner, this.innerMaterial); this.innerMesh.castShadow = false; this.innerMesh.receiveShadow = true; this.localGroup.add(this.innerMesh); }
    const context = contextTerrainGeometry(terrain);
    if (context) {
      this.contextMesh = new THREE.Mesh(context, this.contextMaterial);
      this.contextMesh.castShadow = false; this.contextMesh.receiveShadow = true;
      this.localGroup.add(this.contextMesh);
    } else this.contextMesh = null;
    this.horizonKey = '';
    if (this.landing) { this.localGroup.remove(this.landing.group); this.landing.dispose(); this.landing = null; }
    if (this.lander) { this.localGroup.remove(this.lander); this.lander = null; }
    this.walker.x = this.walker.z = 0; this.walker.here = null; this.landWalker();
    if (this.view === 'surface') this.ensureGround();
    // Rays and horizon need the terrain: refresh them now if directions already arrived.
    if (this.result) this.update(this.result, this.date, this.heightM, this.selected);
    this.resetCamera(); this.invalidate();
  }

  // Adaptive resolution: the time between frames drawn back to back. Slower than ~32 fps for 2.5 s: render 25 % fewer
  // pixels per side (down to 56 %); faster than ~48 fps for 8 s: back up. A change reallocates the render targets
  // (~0.2 s on an iGPU), so it happens rarely and in large steps.
  adaptResolution(now) {
    const s = this.frameStats, ft = now - s.last; s.last = now; if (ft > 120) return;
    s.ema = s.ema ? s.ema * .9 + ft * .1 : ft;
    s.slow = s.ema > 31 ? s.slow + ft : 0; s.fast = s.ema < 21 ? s.fast + ft : 0;
    if (s.slow > 2500 && this.resScale > .57) { this.setResolutionScale(Math.max(.56, this.resScale * .75)); s.slow = 0; s.ema = 0; }
    else if (s.fast > 8000 && this.resScale < 1) { this.setResolutionScale(Math.min(1, this.resScale / .75)); s.fast = 0; s.ema = 0; }
  }
  setResolutionScale(k) {
    this.resScale = k; this.renderer.setPixelRatio(this.basePixelRatio * k); this.sky.scale = k; this.resize();
  }
  setReadingLight(on) { this.readingLight = on; if (this.result) this.applyLights(); this.invalidate(); }
  setPsr(on) { this.psrUniform.value = on ? 1 : 0; this.invalidate(); }
  applyLights() {
    const r = this.result, globe = this.view === 'globe';
    this.sunlight.target.position.set(0, 0, 0);
    if (globe) this.sunlight.position.copy(bodyToScene(unit(r.eph.sun)).multiplyScalar(450));
    else { this.groundLight.setSun(v3(r.sun.direction)); REGOLITH_UNIFORMS.uRegolithSun.value.copy(v3(r.sun.direction)).normalize(); this.placeNearLights(); }
    this.sunlight.castShadow = !globe;
    // During an eclipse the Earth covers part or all of the Sun: the direct light falls with the covered share.
    this.sunlight.intensity = 3.1 * Math.max(0, 1 - (r.sun.eclipse || 0));
    const earth = v3(r.earth.direction).normalize(), sun = v3(r.sun.direction).normalize();
    this.groundEarthshine.direction.value.copy(earth).transformDirection(this.groundSpace.matrix.value);
    this.groundEarthshine.intensity.value = !globe && earth.y > 0 ? earthshineIrradiance(Math.acos(THREE.MathUtils.clamp(-sun.dot(earth), -1, 1)), r.earth.distanceKm, 1, 3.1) : 0;
    this.earthlight.position.copy(v3(r.earth.direction).multiplyScalar(450));
    this.earthlight.intensity = this.readingLight && !globe ? 0.55 : 0;
    this.fill.intensity = this.readingLight ? 0.35 : globe ? 0.04 : 0;
    this.sunlight.shadow.needsUpdate = true;
  }

  // result: evaluate() for the primary site. Sun and Earth sit far away along their directions.
  update(result, date, heightM, selected) {
    this.result = result; this.heightM = heightM; this.date = date; this.selected = selected;
    this.sky.update(result, date);
    this.orientEarth(result, date);
    this.applyLights();
    this.globeMarkers.forEach(marker => { marker.visible = selected.includes(marker.userData.siteId); marker.scale.setScalar(marker.userData.siteId === result.siteId ? 1.8 : 1); });
    if (this.terrain) {
      const h = heightM / 1000, origin = new THREE.Vector3(0, h, 0);
      this.observer.position.set(0, 0, 0);
      this.rays.sun.update(origin, v3(result.sun.direction), this.terrain, h);
      this.rays.earth.update(origin, v3(result.earth.direction), this.terrain, h);
      this.updateHorizon(heightM);
    }
    this.placeSites(); this.orientStars(); this.applyView();
    // In the lunar module (or on the way in) the walker stays put: placing it would pull the camera back to where the
    // walker stood outside every time the clock moves (playback, a new date).
    if (this.view === 'surface') { if (this.walker.cabin) this.placeNearLights(); else this.placeWalker(); this.checkHere(true); }
    this.walkTexts(); this.invalidate();
  }

  // Tangent-plane position of every other compared site, on the relief of the explored one.
  placeSites() {
    if (!this.terrain) return;
    const here = siteBasis(this.terrain.site), dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const key = `${this.terrain.site.id}|${(this.selected || []).join(',')}|${this.t('site.shackleton')}`;
    if (key === this.sitesKey) return; this.sitesKey = key;
    for (const p of this.sitePins) {
      p.shown = p.site.id !== this.terrain.site.id && (this.selected || []).includes(p.site.id);
      if (!p.shown) continue;
      const up = siteBasis(p.site).up, c = dot3(up, here.up), x = RADIUS_KM * dot3(up, here.east) / c, z = -RADIUS_KM * dot3(up, here.north) / c;
      p.km = RADIUS_KM * Math.acos(Math.min(1, c)); p.base.set(x, this.terrain.heightAt(x, z), z);
      const points = Array.from({ length: 65 }, (_, i) => { const k = i / 64; return new THREE.Vector3(x * k, this.terrain.heightAt(x * k, z * k) + 0.12, z * k); });
      p.link.geometry.dispose(); p.link.geometry = new THREE.BufferGeometry().setFromPoints(points);
      p.el.children[1].textContent = this.t(`site.${p.site.id}`); p.el.children[2].textContent = `${number(Math.round(p.km))} km`;
      p.el.setAttribute('aria-label', `${this.t(`site.${p.site.id}`)}, ${number(Math.round(p.km))} km`);
    }
  }

  // Earth-fixed -> J2000 by Greenwich sidereal time (precession ignored, ~0.4° in 2026),
  // then J2000 -> local scene axes (east, up, -north); the mesh maps lon 0 to +x and north to +y.
  orientEarth(result, date) {
    const astronomy = window.Astronomy; if (!astronomy || !this.terrain) return;
    const frame = result.eph.frame, b = siteBasis(this.terrain.site);
    const rx = combine(frame, b.east), ry = combine(frame, b.up), rz = combine(frame, b.north).map(x => -x);
    const toScene = new THREE.Matrix4().set(rx[0], rx[1], rx[2], 0, ry[0], ry[1], ry[2], 0, rz[0], rz[1], rz[2], 0, 0, 0, 0, 1);
    const spin = new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(astronomy.SiderealTime(date) * 15));
    const mesh = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
    this.earth.quaternion.setFromRotationMatrix(toScene.multiply(spin).multiply(mesh));
  }

  // paths: { sun: [{ direction, visible }], earth: [...] } for the coming hours.
  setPaths(paths) {
    const all = [...paths.sun.map(p => ['sun', p]), ...paths.earth.map(p => ['earth', p])];
    const position = new Float32Array(all.length * 3), color = new Float32Array(all.length * 3);
    const sun = new THREE.Color(SCENE_COLORS.sun), earth = new THREE.Color(SCENE_COLORS.earth), blocked = new THREE.Color(0x55554f);
    all.forEach(([body, p], i) => {
      position.set(v3(p.direction).multiplyScalar(PATH_RADIUS).toArray(), i * 3);
      const c = p.visible ? (body === 'sun' ? sun : earth) : blocked;
      color.set([c.r, c.g, c.b], i * 3);
    });
    this.paths.geometry.dispose();
    this.paths.geometry = new THREE.BufferGeometry();
    this.paths.geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    this.paths.geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
    this.invalidate();
  }

  updateHorizon(heightM) {
    const key = `${this.terrain.site.id}|${heightM}`;
    if (key === this.horizonKey) return; this.horizonKey = key;
    const values = this.terrain.horizon(heightM), points = [];
    for (let i = 0; i < values.length; i++) {
      const az = THREE.MathUtils.degToRad(i / 2), el = THREE.MathUtils.degToRad(values[i]);
      points.push(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(HORIZON_RADIUS).add(new THREE.Vector3(0, heightM / 1000, 0)));
    }
    this.horizonLine.geometry.dispose();
    this.horizonLine.geometry = new THREE.BufferGeometry().setFromPoints(points);
  }

  orientStars() {
    if (!this.stars || !this.result || !this.terrain) return;
    const frame = this.result.eph.frame;
    if (this.view === 'globe') setRotationRows(this.stars, frame.x, frame.z, frame.y.map(x => -x));
    else {
      const b = siteBasis(this.terrain.site);
      setRotationRows(this.stars, combine(frame, b.east), combine(frame, b.up), combine(frame, b.north).map(x => -x));
    }
  }

  applyView() {
    const local = this.view !== 'globe';
    this.localGroup.visible = local; this.globeGroup.visible = !local;
    this.rays.sun.visible = this.rays.earth.visible = this.view === 'terrain';
    this.observer.visible = this.view === 'terrain';
    const surface = this.view === 'surface', atPoint = Math.hypot(this.walker.x, this.walker.z) < .001;
    this.horizonLine.visible = surface && atPoint && !this.walker.cabin;
    this.helmet.classList.toggle('on', surface && this.walker.helmet && !this.insideCabin()); this.helmet.classList.toggle('visor', this.walker.visor);
    this.walkHud.hidden = !surface; this.astronaut.visible = surface && Boolean(this.landing) && !this.walker.cabin;
    if (this.lander) this.lander.visible = surface && (this.walker.lander || this.walker.cabin);
    if (surface) this.ensureGround();
    this.paths.visible = local && !this.telephoto && !this.walker.cabin;
    for (const p of this.sitePins) { p.pin.visible = local && p.shown && !this.telephoto; p.link.visible = this.view === 'terrain' && p.shown; }
    if (this.stars) this.stars.material.uniforms.uOpacity.value = this.view === 'terrain' ? 0.55 : 0.9;
  }

  setView(view) {
    if (view !== 'surface') { this.walker.keys.clear(); this.landWalker(); if (this.cabinPending) { this.cabinPending = null; this.setFade(0); } if (this.walker.cabin) this.setCabin(false, false); }
    this.view = view; this.sky.setView(view); this.applyView();
    if (this.result) { this.applyLights(); this.orientStars(); }
    this.resetCamera();
  }

  resetCamera() {
    if (!this.terrain) return;
    const surface = this.view === 'surface', globe = this.view === 'globe';
    this.controls.enablePan = this.view === 'terrain';
    this.controls.minDistance = globe ? 13 : surface ? 0.00005 : 2;
    this.controls.maxDistance = globe ? 60 : surface ? 0.0001 : 160;
    this.controls.minPolarAngle = surface ? 0.08 : 0.02;
    this.controls.maxPolarAngle = globe ? Math.PI - 0.005 : surface ? Math.PI - 0.08 : Math.PI * 0.485;
    this.camera.up.set(0, 1, 0); this.controls.rotateSpeed = 1; this.controls.enableZoom = !surface; this.telephoto = false; this.paths.visible = this.view !== 'globe';
    if (globe) {
      this.controls.target.set(0, 0, 0);
      const u = bodyToScene(siteBasis(this.terrain.site).up); u.x += 0.2; u.z += 0.3;
      this.camera.position.copy(u.normalize().multiplyScalar(32)); this.camera.fov = 40;
    } else if (surface) {
      this.camera.fov = 60; this.walker.x = this.walker.z = 0; this.walker.here = null; this.landWalker();
      const direction = this.result?.sun.direction || [0, 0.02, -1];
      this.controls.target.copy(this.walkerEye());
      const flat = new THREE.Vector3(direction[0], 0.06, direction[2]).normalize();
      this.camera.position.copy(this.controls.target).sub(flat.multiplyScalar(0.00008));
    } else {
      // Behind the observer, slightly off the sunline: grazing light reads the relief best.
      this.camera.fov = 42;
      const d = this.result?.sun.direction || [0.7, 0.02, 0.7];
      const toward = new THREE.Vector3(d[0], 0, d[2]).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), -0.32);
      this.controls.target.set(toward.x * 6, 0, toward.z * 6);
      this.camera.position.set(-toward.x * 38, 9.5, -toward.z * 38);
    }
    this.camera.updateProjectionMatrix(); this.controls.update(); this.invalidate();
  }

  focus(body) {
    if (!this.result) return;
    if (this.view === 'globe') this.setView('terrain');
    const direction = v3(this.result[body].direction);
    this.controls.target.copy(this.view === 'surface' ? this.walkerEye() : new THREE.Vector3(0, this.heightM / 1000, 0));
    if (this.view === 'surface') {
      // Telephoto: Earth spans ~1.9° from the Moon; a ~3° field fills the view with its real phase.
      this.camera.position.copy(this.controls.target).sub(direction.multiplyScalar(0.00008));
      this.setFov(body === 'earth' ? 3 : 14);
    }
    else {
      const flat = new THREE.Vector3(direction.x, 0, direction.z).normalize();
      this.camera.position.set(-flat.x * 30, 7, -flat.z * 30);
    }
    this.controls.update(); this.invalidate();
  }

  setFov(fov) {
    this.camera.fov = THREE.MathUtils.clamp(fov, 1.5, 75); this.telephoto = this.camera.fov < 20; this.applyView();
    this.controls.rotateSpeed = Math.min(1, this.camera.fov / 60); this.camera.updateProjectionMatrix(); this.invalidate();
  }

  updateThickness() {
    // Site pins keep a constant apparent size, whatever their distance.
    if (this.view !== 'globe') for (const p of this.sitePins) {
      if (!p.shown) continue;
      const r = Math.max(0.006, this.camera.position.distanceTo(p.base) * 0.0016 * (this.camera.fov / 42)), h = r * 30;
      p.pin.scale.set(r, h, r); p.pin.position.copy(p.base).setY(p.base.y + h / 2); p.top.copy(p.base).setY(p.base.y + h);
    }
    if (this.view !== 'terrain') return;
    const r = Math.max(0.008, this.camera.position.distanceTo(new THREE.Vector3(0, 0, 0)) * 0.0021);
    this.rays.sun.thickness(r, this.camera); this.rays.earth.thickness(r, this.camera);
    this.observerPin.scale.set(r * 0.8, r * 22, r * 0.8); this.observerPin.position.y = r * 11;
    this.observerRing.scale.setScalar(r * 2.4);
    this.paths.material.size = this.lowPower ? 3 : 3.6;
  }

  resize() {
    const { width, height } = this.container.getBoundingClientRect(); if (!width || !height) return;
    this.renderer.setSize(width, height, false); this.sky?.resize(width, height, this.renderer.getPixelRatio()); this.camera.aspect = width / height; if (this.camera.view?.enabled) this.camera.clearViewOffset(); this.camera.updateProjectionMatrix(); this.invalidate();
  }

  project(position) {
    const p = position.clone().project(this.camera), w = this.container.clientWidth, h = this.container.clientHeight;
    return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h, visible: p.z < 1 && p.z > -1 && Math.abs(p.x) < 0.96 && Math.abs(p.y) < 0.92 };
  }
  updateLabels() {
    const local = this.view !== 'globe', away = this.view === 'surface' && (Math.hypot(this.walker.x, this.walker.z) >= .001 || this.walker.cabin);
    this.placeWalkOverlay();
    for (const body of ['sun', 'earth']) {
      const label = document.getElementById(`${body}Label`); if (!label) continue;
      // Their numbers belong to the reference point: away from it, the walk panel says what is in view.
      if (!local || !this.result || this.telephoto || away) { label.style.opacity = '0'; continue; }
      const p = this.project(this[body].position);
      label.style.opacity = p.visible ? '1' : '0'; label.style.transform = `translate(${p.x + 14}px,${p.y - 14}px)`;
    }
    ['sun', 'earth'].forEach((body, i) => {
      const el = this.blockLabels[i], state = this.rays[body].state;
      if (this.view !== 'terrain' || !state?.blocked) { el.style.opacity = '0'; return; }
      const p = this.project(state.point);
      el.textContent = this.t(`scene.blocked.${body}`, { d: distance(state.distance) });
      el.style.opacity = p.visible ? '1' : '0'; el.style.transform = `translate(${p.x + 12}px,${p.y + 10}px)`;
    });
    // Site labels never leave the picture: outside the free area of the scene they stick to its edge
    // and an arrow points the way.
    if (local && !this.telephoto && !this.walker.cabin && this.sitePins.some(p => p.shown)) {
      const box = this.container.getBoundingClientRect(), w = box.width, h = box.height;
      const rect = sel => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return r.width && r.top < box.bottom && r.bottom > box.top && r.left < box.right ? r : null; };
      const answer = rect('.answer'), deck = rect('.console'), title = rect('.stage-title');
      const right = (answer ? answer.left - box.left : w) - 12, bottom = (deck ? deck.top - box.top - 62 : h) - 12;
      for (const p of this.sitePins) {
        if (!p.shown) { p.el.classList.remove('shown'); p.el.style.opacity = '0'; continue; }
        const view = p.top.clone().applyMatrix4(this.camera.matrixWorldInverse), ndc = p.top.clone().project(this.camera);
        let x = (ndc.x * 0.5 + 0.5) * w, y = (-ndc.y * 0.5 + 0.5) * h;
        if (view.z > 0) { const k = 4 / Math.max(1e-6, Math.hypot(ndc.x, ndc.y)); x = (-ndc.x * k * 0.5 + 0.5) * w; y = (ndc.y * k * 0.5 + 0.5) * h; }
        const ew = p.el.offsetWidth || 170, eh = 28;
        let lx = Math.min(Math.max(x - 14, 12), right - ew), ly = Math.min(Math.max(y - 32, 12), bottom - eh);
        if (title && lx < title.right - box.left + 8 && ly < title.bottom - box.top + 8) ly = Math.min(title.bottom - box.top + 8, bottom - eh);
        const off = Math.abs(lx - (x - 14)) > 2 || Math.abs(ly - (y - 32)) > 2;
        p.el.classList.toggle('off', off); p.el.classList.add('shown'); p.el.style.opacity = '1';
        p.el.style.transform = `translate(${lx}px,${ly}px)`;
        if (off) p.el.lastElementChild.style.transform = `rotate(${Math.atan2(y - (ly + eh / 2), x - (lx + ew / 2))}rad)`;
      }
    } else for (const p of this.sitePins) { p.el.classList.remove('shown'); p.el.style.opacity = '0'; }
    this.siteLabels.forEach((el, i) => {
      const marker = this.globeMarkers[i];
      if (local || !marker.visible) { el.style.opacity = '0'; return; }
      const world = marker.getWorldPosition(new THREE.Vector3());
      const facing = world.clone().normalize().dot(this.camera.position.clone().normalize()) > 0.05;
      const p = this.project(world);
      el.style.opacity = p.visible && facing ? '1' : '0'; el.style.transform = `translate(${p.x + 8}px,${p.y - 22}px)`;
    });
  }
  // ----- Walking (surface view) -----
  // The part of the scene the panels leave free (answer on the right, console below), in scene pixels.
  freeArea() {
    const box = this.container.getBoundingClientRect(), w = box.width, h = box.height;
    const rect = sel => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return r.width && r.top < box.bottom && r.bottom > box.top && r.left < box.right ? r : null; };
    const answer = rect('.answer'), deck = rect('.console');
    return { w, h, fw: Math.max(240, Math.min(w, answer ? answer.left - box.left - 8 : w)), fh: Math.max(200, Math.min(h, deck ? deck.top - box.top - 8 : h)) };
  }
  // A shifted lens (as on a view camera): the full frame is enlarged so that its centre, the horizon straight
  // ahead, falls in the middle of the free area; the canvas shows the part of that frame it covers.
  frameView() {
    const cam = this.camera;
    if (this.view !== 'surface') { if (cam.view?.enabled) { cam.clearViewOffset(); const { width, height } = this.container.getBoundingClientRect(); if (width && height) { cam.aspect = width / height; cam.updateProjectionMatrix(); } } return; }
    const { w, h, fw, fh } = this.free = this.freeArea(), dx = Math.max(0, (w - fw) / 2), dy = Math.max(0, (h - fh) / 2), FW = w + 2 * dx, FH = h + 2 * dy;
    if (cam.view?.enabled && cam.view.fullWidth === FW && cam.view.fullHeight === FH) return;
    cam.aspect = FW / FH; cam.setViewOffset(FW, FH, 2 * dx, 2 * dy, w, h);
  }
  // The detailed ground around the reference point, built the first time the surface view opens for a site; the
  // 40 m tile gets a hole where it lies.
  ensureGround() {
    if (this.landing || this.groundPending || !this.terrain) return;
    this.groundPending = true; this.walkHud.dataset.state = 'preparing'; this.walkTexts();
    setTimeout(() => {
      this.groundPending = false; if (this.disposed || !this.terrain || this.landing) return;
      const terrain = this.terrain, space = siteSpace(siteBasis(terrain.site), RADIUS_KM + terrain.elevationKm - terrain.height(0, 0));
      this.landing = new LandingSite(terrain, { seed: [...terrain.site.id].reduce((s, c) => s + c.charCodeAt(0), 0), space, earthshine: this.groundEarthshine, pad: false, lowPower: this.lowPower });
      this.landing.dust.visible = false;
      this.landing.group.traverse(o => { if (o.isMesh || o.isInstancedMesh) { o.castShadow = o !== this.landing.mesh && !o.userData.groundFillet; o.receiveShadow = true; for (const m of Array.isArray(o.material) ? o.material : [o.material]) this.groundLight.attach(m); } });
      this.groundLight.setLanding(this.landing);
      this.localGroup.add(this.landing.group);
      if (this.innerMesh) {
        const inner = innerTerrainGeometry(terrain, { stride: this.lowPower ? 2 : 1, hole: this.landing.half });
        if (inner) { this.innerMesh.geometry.dispose(); this.innerMesh.geometry = inner; }
      }
      delete this.walkHud.dataset.state; this.landLander();
      if (this.view === 'surface') { this.placeWalker(true); this.checkHere(true); }
      if (this.result) this.applyLights();
      this.applyView(); this.walkTexts(); this.invalidate();
    }, 40);
  }
  // The Apollo lunar module, NASA's own model (nasa-models.js, the same as in the mission), landed ~30 m from the
  // reference point on the flattest spot nearby, tilted with the ground under it, plumes off.
  landLander() {
    if (this.lander || this.landerPending || !this.landing) return;
    this.landerPending = true;
    loadNasaModels().then(nasa => {
      this.landerPending = false; if (this.disposed || !this.landing || this.lander) return;
      if (!this.landerMaterials) { this.landerEnv = makeEnvironment(this.renderer, { ground: [.34, .33, .31] }); this.landerMaterials = createMaterials(this.landerEnv.texture); this.landerMaterials.onTextureLoad = () => this.invalidate(); }
      const lm = buildLM(this.landerMaterials, nasa);
      // The crew cabin (lm-cabin.js), inside the ascent stage, for 'Enter the lander'.
      this.cabin = buildLMCabin({ exterior: lm, worldScale: .001 }); this.cabin.group.visible = false; lm.add(this.cabin.group);
      this.cabin.lights = []; this.cabin.group.traverse(o => { if (o.isLight) { this.cabin.lights.push([o, o.intensity]); o.intensity = 0; } });
      for (const stage of [lm.userData.descent, lm.userData.ascent]) if (stage?.userData.plume) stage.userData.plume.visible = false;
      lm.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      // Where: in front-right of the first view (which faces the Sun), on the least sloping of a ring of candidates.
      const sun = this.result ? v3(this.result.sun.direction) : new THREE.Vector3(0, 0, -1), base = Math.atan2(sun.x, -sun.z) + .35;
      let best = null;
      for (let i = -5; i <= 5; i++) for (const r of [.026, .032, .038]) {
        const a = base + i * .05, x = Math.sin(a) * r, z = -Math.cos(a) * r, n = this.groundNormal(x, z);
        if (!best || n.y > best.n.y) best = { x, z, n };
      }
      const g = this.lander = new THREE.Group(), body = new THREE.Group(); body.scale.setScalar(.001); body.add(lm); g.add(body);
      g.position.set(best.x, this.groundAt(best.x, best.z) - .00003, best.z); // footpads pressed a few centimetres into the regolith
      const tilt = new THREE.Quaternion().setFromUnitVectors(Y_UP, best.n), face = new THREE.Quaternion().setFromAxisAngle(Y_UP, Math.atan2(-best.x, -best.z) + Math.PI);
      g.quaternion.copy(tilt).multiply(face); g.userData.at = { x: best.x, z: best.z };
      this.localGroup.add(g); this.applyView(); if (this.result) this.applyLights(); this.checkHere(true); this.invalidate();
    });
  }
  // Ground normal from the heights 2 m around a point.
  groundNormal(x, z) {
    const e = .002, dx = (this.groundAt(x + e, z) - this.groundAt(x - e, z)) / (2 * e), dz = (this.groundAt(x, z + e) - this.groundAt(x, z - e)) / (2 * e);
    return new THREE.Vector3(-dx, 1, -dz).normalize();
  }
  // Is the walker's eye in the lander's shadow? The sunward ray against the lander as a 2.3 m × 7 m cylinder.
  inLanderShadow(eye, sun) {
    if (!this.lander?.visible) return false;
    const L = this.lander.position, dx = eye.x - L.x, dz = eye.z - L.z, h = Math.hypot(sun.x, sun.z); if (h < 1e-6) return false;
    const ux = sun.x / h, uz = sun.z / h, along = -(dx * ux + dz * uz); if (along <= 0) return false;
    const miss = Math.abs(dx * uz - dz * ux); if (miss > .0023) return false;
    const y = eye.y + along * sun.y / h - L.y; return y >= 0 && y <= .007;
  }
  groundAt(x, z) {
    const l = this.landing;
    return l && Math.abs(x) < l.half && Math.abs(z) < l.half ? l.heightAt(x, z) : this.terrain ? this.terrain.heightAt(x, z) : 0;
  }
  walkerGround() { return new THREE.Vector3(this.walker.x, this.groundAt(this.walker.x, this.walker.z), this.walker.z); }
  walkerEye() { return this.walkerGround().setY(this.groundAt(this.walker.x, this.walker.z) + (this.heightM || 2) / 1000 + this.walker.yoff + this.bob()); }
  // A lunar lope: slow, low bounces while moving (none with reduced motion).
  bob() { const w = this.walker; return !w.air && !w.run && w.keys.size && !reducedMotion() ? Math.abs(Math.sin(w.phase)) * .00003 : 0; }
  // Keeps the look direction, moves the eyes to the walker.
  placeWalker(keepLook = true) {
    if (!this.terrain) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.controls.target.copy(this.walkerEye());
    if (keepLook && offset.lengthSq() > 0) this.camera.position.copy(this.controls.target).add(offset);
    const at = this.walkerGround(), look = this.controls.target.clone().sub(this.camera.position); look.y = 0;
    this.astronaut.position.copy(at); this.astronaut.position.y += this.walker.yoff; if (look.lengthSq() > 1e-16) this.astronaut.rotation.y = Math.atan2(-look.x, -look.z);
    this.placeNearLights(); this.controls.update();
  }
  placeNearLights() {
    if (!this.result) return;
    const d = v3(this.result.sun.direction), inside = this.walker.cabin && this.lander;
    const at = inside ? this.lander.position.clone() : this.view === 'surface' ? this.walkerGround() : new THREE.Vector3();
    const box = inside ? { w: .004, h: .004 } : { w: NEAR_SHADOW.halfWidthKm, h: NEAR_SHADOW.halfHeightKm }, cam = this.sunlight.shadow.camera;
    if (cam.right !== box.w || cam.top !== box.h) { Object.assign(cam, { left: -box.w, right: box.w, top: box.h, bottom: -box.h }); cam.updateProjectionMatrix(); }
    this.sunlight.target.position.copy(at); this.sunlight.position.copy(at).addScaledVector(d, .6); this.sunlight.target.updateMatrixWorld();
  }
  // 'Enter the lander': the camera at the Commander's eye, 1.5 m above the ascent-stage floor, looking out of the
  // left triangular window (Apollo crews flew the descent standing, in restraints). The exterior shell of the ascent
  // stage hides; the cabin's walls, its floodlights and the sunlight through the windows take over. Drag looks around.
  // 'Leave the lander' puts the walker at the foot of the ladder, facing the lunar module.
  setCabin(on, reset = true, animate = true, fromBlack = false) {
    const w = this.walker; if (on && (!this.cabin || !this.lander || this.view !== 'surface')) return;
    if (on && !this.cabinWarm && animate && !reducedMotion()) {
      // The first time in, the cabin's shaders take 1–2 s to build on integrated GPUs: the picture dips to black at
      // once (the click is answered), they build behind it, and the walk-in starts out of the black.
      const token = this.cabinPending = {}; this.setFade(1, 250);
      setTimeout(() => { if (this.cabinPending !== token) return; this.cabinPending = null; if (this.disposed || this.view !== 'surface' || w.cabin) { this.setFade(0); return; } this.warmCabin(); this.setCabin(true, reset, animate, true); }, 280);
      return;
    }
    if (on) this.warmCabin();
    w.cabin = Boolean(on); w.keys.clear(); this.landWalker(); this.cabinEntry = null; this.setFade(0);
    this.camera.near = w.cabin ? .00002 : .0005;
    if (w.cabin) {
      this.lander.updateMatrixWorld(true);
      const F = this.landerFrame(), eye = F.at(this.cabin.eyes.cdr.toArray()), look = F.dir(0, Math.atan2(this.cabin.lookDir.y, this.cabin.lookDir.z));
      if (animate && !reducedMotion()) { this.cabinEntry = this.entryPlan(F, fromBlack); this.setInteriorView(false); this.updateCabinEntry(0); }
      else { this.setInteriorView(true); this.controls.target.copy(eye); this.camera.position.copy(eye).addScaledVector(look, -.00008); }
      this.setFov(70);
    } else this.setInteriorView(false);
    this.placeNearLights(); this.sunlight.shadow.needsUpdate = true;
    this.applyView(); this.walkTexts();
    if (!w.cabin && reset) {
      this.resetCamera();
      if (this.lander) {
        const F = this.landerFrame(), foot = F.at([.04, 0, 5.6]); w.x = foot.x; w.z = foot.z;
        const eye = this.walkerEye(); this.controls.target.copy(eye); this.camera.position.copy(eye).addScaledVector(F.dir(Math.PI, .1), -.00008);
        this.setFade(1); requestAnimationFrame(() => this.setFade(0, 400));
      }
      this.placeWalker(); this.checkHere(true); this.applyView(); this.walkTexts();
    }
    this.camera.updateProjectionMatrix(); this.controls.update(); this.invalidate();
  }
  // Inside the cabin (not on the way in).
  insideCabin() { return this.walker.cabin && (!this.cabinEntry || this.cabinEntry.inside); }
  // The lunar module's own frame (metres: +Y up, +Z out of the forward hatch, +X the Commander's side) in the scene.
  landerFrame() {
    const g = this.cabin.group; g.updateWorldMatrix(true, false);
    const o = g.localToWorld(new THREE.Vector3()), axis = v => g.localToWorld(new THREE.Vector3(...v)).sub(o).normalize();
    const ex = axis([1, 0, 0]), ey = axis([0, 1, 0]), ez = axis([0, 0, 1]);
    return { o, ex, ey, ez, at: p => g.localToWorld(new THREE.Vector3(...p)), toLocal: p => g.worldToLocal(p.clone()),
      dir: (yaw, pitch) => ez.clone().multiplyScalar(Math.cos(yaw) * Math.cos(pitch)).addScaledVector(ex, Math.sin(yaw) * Math.cos(pitch)).addScaledVector(ey, Math.sin(pitch)).normalize(),
      yaw: d => Math.atan2(d.dot(ex), d.dot(ez)) };
  }
  // The walk-in, on foot: round the legs (outside a 5.3 m circle) to the foot of the ladder on the forward leg, up the
  // ladder to the porch, in through the forward hatch on hands and knees (there the exterior shell gives way to the
  // cabin), up at the Commander's station and the turn to his window. From farther than ~9 m the walk is cut short: a
  // dip to black and the walker is 3 m from the ladder. Keyframes in the lunar module's frame (metres): eye position,
  // heading (0 = out of the hatch) and pitch, at times in seconds.
  entryPlan(F, fromBlack = false) {
    const eye0 = this.controls.target.clone(), above = Math.max(.0012, eye0.y - this.groundAt(eye0.x, eye0.z)), footEye = .00175;
    const foot = F.at([.04, 0, 5.6]), path = roundPath({ x: eye0.x, z: eye0.z }, { x: foot.x, z: foot.z }, { x: F.o.x, z: F.o.z }, .0053);
    const lengths = path.slice(1).map((p, i) => Math.hypot(p.x - path[i].x, p.z - path[i].z)), total = lengths.reduce((s, x) => s + x, 0);
    const cut = total > .009 ? .3 : 0, from = cut ? total - .003 : 0;
    // Points along the ground path every ~1.2 m from `from` to the ladder.
    const pointAt = s => { let i = 0; while (i < lengths.length - 1 && s > lengths[i]) { s -= lengths[i]; i++; } const k = lengths[i] ? Math.min(1, s / lengths[i]) : 1; return { x: path[i].x + (path[i + 1].x - path[i].x) * k, z: path[i].z + (path[i + 1].z - path[i].z) * k }; };
    const walk = total - from, steps = Math.max(1, Math.round(walk / .0012)), keys = [];
    let time = cut, last = null;
    for (let i = 0; i <= steps; i++) {
      const s = from + walk * i / steps, q = pointAt(s), h = THREE.MathUtils.lerp(cut ? footEye + (above - footEye) * .3 : above, footEye, i / steps);
      const p = new THREE.Vector3(q.x, this.groundAt(q.x, q.z) + h, q.z), ahead = i < steps ? (() => { const n = pointAt(Math.min(total, s + .0006)); return new THREE.Vector3(n.x - q.x, 0, n.z - q.z); })() : null;
      if (last) time += Math.max(.12, last.distanceTo(p) * 1000 / 3.4) + (i === 1 ? .2 : 0);
      // Looking mostly at the lunar module while going round it (a third of the way toward where the feet go).
      const porch = F.at([.04, 3.3, 2.5]).sub(p).setY(0), toward = F.yaw(porch.normalize()), along = !ahead || ahead.lengthSq() < 1e-14 ? toward : F.yaw(ahead.normalize());
      keys.push({ t: time, p, yaw: i === steps ? Math.PI : toward + .35 * Math.atan2(Math.sin(along - toward), Math.cos(along - toward)), pitch: i === steps ? .2 : .08 }); last = p;
    }
    // Without a cut the first frame keeps the look the walker had, then turns to the way it walks.
    if (!cut) { const d = this.controls.target.clone().sub(this.camera.position).normalize(); keys[0].yaw = F.yaw(d); keys[0].pitch = Math.asin(THREE.MathUtils.clamp(d.dot(F.ey), -1, 1)); }
    // From the foot of the ladder: climb, kneel on the porch, through the hatch, stand, turn to the window.
    const cdr = this.cabin.eyes.cdr, look = Math.atan2(this.cabin.lookDir.y, this.cabin.lookDir.z);
    for (const [dt, p, yaw, pitch] of [[.35, [.04, 2.3, 4.55], Math.PI, .25], [.55, [.04, 3.25, 3.75], Math.PI, .05], [.55, [.04, 4.3, 3.05], Math.PI, -.35], [.3, [.04, 3.98, 2.72], Math.PI, -.3],
      [.3, [.04, 3.6, 2.12], Math.PI, -.1], [.25, [.04, 3.62, 1.42], Math.PI, 0], [.5, [.3, 4.4, 1.05], Math.PI - .9, 0], [.4, [cdr.x, cdr.y, cdr.z + .002], Math.PI - 2, -.1], [.7, [cdr.x, cdr.y, cdr.z], 0, look]]) {
      time += dt; keys.push({ t: time, p: F.at(p), yaw, pitch });
    }
    // Headings unwrapped (no turn the long way round), then the eye moved along a smooth curve at a smooth speed.
    for (let i = 1; i < keys.length; i++) { let y = keys[i].yaw; while (y - keys[i - 1].yaw > Math.PI) y -= 2 * Math.PI; while (y - keys[i - 1].yaw < -Math.PI) y += 2 * Math.PI; keys[i].yaw = y; }
    const curve = new THREE.CatmullRomCurve3(keys.map(k => k.p), false, 'centripetal'), n = 400, lens = curve.getLengths(n), length = lens[n];
    const at = u => { const x = u * n, i = Math.min(n - 1, Math.floor(x)); return lens[i] + (lens[i + 1] - lens[i]) * (x - i); };
    const ts = keys.map(k => k.t);
    return { F, time: 0, cut, fromBlack, end: time, curve, length, inside: false, start: { target: this.controls.target.clone(), camera: this.camera.position.clone() },
      s: smoothThrough(ts, keys.map((_, i) => at(i / (keys.length - 1)))), yaw: smoothThrough(ts, keys.map(k => k.yaw)), pitch: smoothThrough(ts, keys.map(k => k.pitch)) };
  }
  // One frame of the walk-in. Its clock runs on the frames drawn (at most 100 ms each), so a stall cannot skip the
  // hatch; the shell gives way to the cabin when the eye passes the forward hatch.
  updateCabinEntry(dt) {
    const e = this.cabinEntry; if (!e) return;
    e.time += Math.min(dt, .1); const t = e.time;
    if (t < e.cut) { this.setFade(e.fromBlack ? 1 : t / e.cut); this.controls.target.copy(e.start.target); this.camera.position.copy(e.start.camera); this.invalidate(); return; }
    const p = e.curve.getPointAt(THREE.MathUtils.clamp(e.s(t) / e.length, 0, 1)), look = e.F.dir(e.yaw(t), e.pitch(t)), q = e.F.toLocal(p);
    // Through the 0.7 m of hatch tunnel between the hull and the cabin the view goes dark, as a head in a dark hatch:
    // it hides the hull giving way to the cabin and the inside of the closed inner hatch.
    const dark = q.y > 3.1 ? (1 - THREE.MathUtils.smoothstep(q.z, 2.25, 2.45)) * THREE.MathUtils.smoothstep(q.z, 1.36, 1.5) : 0;
    this.setFade(Math.max(e.cut || e.fromBlack ? Math.max(0, 1 - (t - e.cut) / .3) : 0, dark));
    if (!e.inside && q.z < 2.25 && q.y > 3.1) { e.inside = true; this.setInteriorView(true); this.applyView(); }
    this.controls.target.copy(p); this.camera.position.copy(p).addScaledVector(look, -.00008); this.controls.update();
    if (t >= e.end) { this.cabinEntry = null; this.setInteriorView(true); this.setFade(0); this.applyView(); this.walkTexts(); }
    this.invalidate();
  }
  // Black over the scene (0..1), at once or over ms milliseconds; the controls stay above it.
  setFade(k, ms = 0) { if (!this.fade) return; this.fade.style.transition = ms ? `opacity ${ms}ms ease-out` : 'none'; this.fade.style.opacity = String(k); }
  // The cabin's materials, and its lamps (they change the light count every shader in view is built for), compiled once
  // with the cabin shown, into the target the scene is drawn to: otherwise the first entry stalls 1–2 s on its way in.
  warmCabin() {
    if (!this.cabin || this.cabinWarm) return; this.cabinWarm = true;
    const g = this.cabin.group, was = g.visible, r = this.renderer, previous = r.getRenderTarget(); g.visible = true;
    try { r.setRenderTarget(this.sky?.composer?.readBuffer || null); r.compile(this.scene, this.camera); } catch { /* compiled on first use instead */ } finally { r.setRenderTarget(previous); g.visible = was; }
  }
  // Cabin shown and exterior shell hidden (inside), or the other way round.
  setInteriorView(inside) {
    if (!this.cabin) return;
    this.cabin.group.visible = inside; this.cabin.setInterior(inside);
    for (const [light, intensity] of this.cabin.lights) light.intensity = inside ? intensity : 0;
  }
  // Back on the ground at once, with no speed left (a new start, or leaving the surface view).
  landWalker() { Object.assign(this.walker, { air: false, vy: 0, yoff: 0, vx: 0, vz: 0 }); }
  // A jump straight up from where the walker stands, keeping the horizontal speed it had (no steering in the air).
  jump(speed = JUMP_V) {
    const w = this.walker; if (w.air || this.view !== 'surface' || w.cabin) return;
    const v = this.moveVector(); w.vx = v.x; w.vz = v.z; w.air = true; w.vy = speed; this.invalidate();
  }
  // Horizontal velocity the keys ask for (km/s).
  moveVector() {
    const k = this.walker.keys, w = this.walker;
    const ahead = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0), side = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0);
    if (!ahead && !side) return new THREE.Vector3();
    w.run = k.has('shift') || this.walkHud.querySelector('[data-walk-opt=run]').getAttribute('aria-pressed') === 'true';
    const look = this.controls.target.clone().sub(this.camera.position); look.y = 0; look.normalize();
    return look.clone().multiplyScalar(ahead).add(new THREE.Vector3(-look.z, 0, look.x).multiplyScalar(side)).normalize().multiplyScalar(w.run ? RUN_SPEED : WALK_SPEED);
  }
  walk(dt) {
    const k = this.walker.keys, w = this.walker;
    const turn = (k.has('arrowleft') ? 1 : 0) - (k.has('arrowright') ? 1 : 0);
    if (turn) { const offset = this.camera.position.clone().sub(this.controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), turn * dt * 1.4); this.camera.position.copy(this.controls.target).add(offset); }
    let vx = 0, vz = 0;
    if (w.air) {
      // Ballistic: lunar gravity only, the take-off speed kept.
      vx = w.vx; vz = w.vz; w.vy -= G_MOON * dt; w.yoff += w.vy * dt;
      if (w.yoff <= 0) { w.yoff = 0; w.vy = 0; w.air = false; }
    } else {
      const v = this.moveVector(); vx = v.x; vz = v.z;
      // Running is a lope: as soon as the feet touch, the next low hop.
      if ((vx || vz) && w.run) { w.vx = vx; w.vz = vz; w.air = true; w.vy = HOP_V; }
      else if (vx || vz) w.phase += dt * 9.4;
    }
    if (vx || vz) {
      const limit = (this.landing ? this.landing.half : .4) - .006, nx = w.x + vx * dt, nz = w.z + vz * dt;
      w.edge = Math.abs(nx) > limit || Math.abs(nz) > limit;
      w.x = THREE.MathUtils.clamp(nx, -limit, limit); w.z = THREE.MathUtils.clamp(nz, -limit, limit);
      // The lander's legs and footpads span ~9.4 m: stay outside a 4.8 m circle around it.
      if (this.lander?.visible) { const L = this.lander.userData.at, dx = w.x - L.x, dz = w.z - L.z, d = Math.hypot(dx, dz), r = .0048; if (d < r) { const q = r / Math.max(d, 1e-9); w.x = L.x + dx * q; w.z = L.z + dz * q; } }
    }
    this.placeWalker(); this.checkHere(); this.applyView();
  }
  // Sun and Earth from where the walker stands, against the same relief the app uses (centre of each disc).
  checkHere(force = false) {
    const w = this.walker, now = performance.now();
    if (!this.result || !this.terrain || (!force && now - w.checked < 250)) return;
    w.checked = now;
    const h0 = this.groundAt(w.x, w.z) + (this.heightM || 2) / 1000;
    const sun = traceFrom(this.terrain, w.x, w.z, h0, v3(this.result.sun.direction)), earth = traceFrom(this.terrain, w.x, w.z, h0, v3(this.result.earth.direction));
    w.here = { sun, earth, eclipse: this.result.sun.eclipse || 0, lander: sun && this.inLanderShadow(new THREE.Vector3(w.x, h0, w.z), v3(this.result.sun.direction)) };
    // The main light follows what the walker sees of the Sun only through the shadows; nothing to change here.
    this.walkTexts();
  }
  makeAstronaut() {
    // The walker's body: invisible, it only casts the shadow. Suited astronaut, about 1.9 m with the helmet and
    // the backpack; at the pole's grazing Sun its shadow runs tens of metres.
    const m = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }), g = this.astronaut = new THREE.Group();
    const part = (geometry, x, y, z) => { const mesh = new THREE.Mesh(geometry, m); mesh.position.set(x, y, z); mesh.castShadow = true; mesh.frustumCulled = false; g.add(mesh); };
    part(new THREE.CapsuleGeometry(.00023, .00086, 4, 10), 0, .00076, 0);
    part(new THREE.SphereGeometry(.00017, 14, 10), 0, .00172, 0);
    part(new THREE.BoxGeometry(.00052, .0007, .00026), 0, .00118, .00024);
    part(new THREE.CapsuleGeometry(.00007, .00052, 4, 8), .00031, .00112, 0);
    part(new THREE.CapsuleGeometry(.00007, .00052, 4, 8), -.00031, .00112, 0);
    g.visible = false; this.localGroup.add(g);
  }
  makeHelmet(canvas) {
    // Inside the helmet: the shell around the visor opening and the neck ring and chest below, all far out of
    // focus; faint reflections on the bubble; the Sun's glare on the visor; the gold sun visor, when lowered.
    const el = this.helmet = document.createElement('div'); el.className = 'helmet'; el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<div class="helmet-glare"></div><div class="helmet-ghost"></div>
      <svg class="helmet-frame" viewBox="0 0 1000 600" preserveAspectRatio="none">
        <defs>
          <filter id="helmetBlur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="14"/></filter>
          <filter id="helmetSoft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3.5"/></filter>
          <radialGradient id="helmetShell" cx="50%" cy="44%" r="70%"><stop offset="70%" stop-color="#303236"/><stop offset="86%" stop-color="#17181b"/><stop offset="100%" stop-color="#08090a"/></radialGradient>
          <linearGradient id="helmetChest" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3b3e"/><stop offset=".5" stop-color="#1c1d20"/><stop offset="1" stop-color="#0c0c0e"/></linearGradient>
        </defs>
        <path filter="url(#helmetBlur)" fill="url(#helmetShell)" fill-rule="evenodd" d="M-90 -90 H1090 V690 H-90 Z M500 10 C806 10 972 34 986 180 C998 320 984 452 914 540 C836 628 164 628 86 540 C16 452 2 320 14 180 C28 34 194 10 500 10 Z"/>
        <ellipse filter="url(#helmetBlur)" cx="500" cy="716" rx="470" ry="182" fill="url(#helmetChest)"/>
        <path filter="url(#helmetSoft)" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="4" d="M120 560 C300 520 700 520 880 560"/>
        <path filter="url(#helmetSoft)" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="5" stroke-linecap="round" d="M96 128 C170 56 320 26 452 22"/>
        <path filter="url(#helmetSoft)" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="3" stroke-linecap="round" d="M904 132 C930 214 938 300 930 372"/>
      </svg>
      <div class="helmet-visor"></div>`;
    canvas.after(el);
  }
  makeWalkHud(container) {
    const el = this.walkHud = document.createElement('div'); el.className = 'walk-hud'; el.hidden = true;
    const arrow = (key, cls) => `<button type="button" class="walk-key ${cls}" data-walk="${key}"><svg aria-hidden="true"><use href="#i-chevron"/></svg></button>`;
    el.innerHTML = `<p class="walk-info" aria-live="polite"></p>
      <div class="walk-row">
        <div class="walk-pad" role="group">${arrow('arrowup', 'up')}${arrow('arrowleft', 'left')}${arrow('arrowdown', 'down')}${arrow('arrowright', 'right')}</div>
        <div class="walk-opts">
          <button type="button" class="walk-toggle" data-walk-opt="helmet" aria-pressed="true"></button>
          <button type="button" class="walk-toggle" data-walk-opt="visor" aria-pressed="false"></button>
          <button type="button" class="walk-toggle" data-walk-opt="run" aria-pressed="false"></button>
          <button type="button" class="walk-toggle" data-walk-opt="lander" aria-pressed="true"></button>
          <button type="button" class="walk-toggle" data-walk-opt="cabin" aria-pressed="false"></button>
          <button type="button" class="walk-toggle" data-walk-opt="jump"></button>
          <button type="button" class="walk-toggle" data-walk-opt="back"></button>
        </div>
      </div>
      <p class="walk-hint"></p>`;
    // Hold to walk (pointer or touch); release anywhere stops.
    el.querySelectorAll('[data-walk]').forEach(b => {
      const key = b.dataset.walk, stop = () => { this.walker.keys.delete(key); b.classList.remove('held'); };
      b.addEventListener('pointerdown', e => { e.preventDefault(); b.setPointerCapture?.(e.pointerId); this.walker.keys.add(key); b.classList.add('held'); this.invalidate(); });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(type, stop);
    });
    el.querySelectorAll('[data-walk-opt]').forEach(b => b.addEventListener('click', e => {
      // A button pressed with the pointer gives the focus back: Space is the jump key, and on a focused button it would
      // press the button again (out of the lunar module, or back in). From the keyboard (detail 0) the focus stays.
      if (e.detail) b.blur();
      const opt = b.dataset.walkOpt, w = this.walker;
      if (opt === 'jump') { this.jump(); return; }
      // While walking in, the button does nothing: a second click (or a double click) used to cancel half-way and
      // throw the walker back to the reference point.
      if (opt === 'cabin') { if (!this.cabinEntry && !this.cabinPending) this.setCabin(!w.cabin); return; }
      if (opt === 'back') { if (this.cabinPending) { this.cabinPending = null; this.setFade(0); } if (w.cabin) this.setCabin(false); this.resetCamera(); this.placeWalker(); this.checkHere(true); this.applyView(); this.walkTexts(); return; }
      const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on));
      if (opt === 'helmet') w.helmet = on; else if (opt === 'visor') w.visor = on; else if (opt === 'lander') { w.lander = on; this.checkHere(true); } else w.run = on;
      this.applyView(); this.invalidate();
    }));
    container.append(el);
  }
  walkTexts() {
    if (!this.walkHud) return;
    const t = this.t, w = this.walker, el = this.walkHud, put = (node, text) => { if (node.textContent !== text) node.textContent = text; }, attr = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
    const names = { helmet: 'walk.helmet', visor: 'walk.visor', run: 'walk.run', back: 'walk.back', lander: 'walk.lander', jump: 'walk.jump', cabin: w.cabin ? 'walk.cabinOut' : 'walk.cabin' };
    el.querySelectorAll('[data-walk-opt]').forEach(b => put(b, t(names[b.dataset.walkOpt])));
    const aria = { arrowup: 'walk.forward', arrowdown: 'walk.backward', arrowleft: 'walk.turnLeft', arrowright: 'walk.turnRight' };
    el.querySelectorAll('[data-walk]').forEach(b => attr(b, 'aria-label', t(aria[b.dataset.walk])));
    attr(el.querySelector('.walk-pad'), 'aria-label', t('walk.pad'));
    put(el.querySelector('.walk-hint'), t(matchMedia('(hover: hover)').matches ? 'walk.hint' : 'walk.hintTouch'));
    const info = el.querySelector('.walk-info');
    if (el.dataset.state === 'preparing') { put(info, t('walk.preparing')); return; }
    const cabinButton = el.querySelector('[data-walk-opt="cabin"]'); cabinButton.hidden = !this.cabin; attr(cabinButton, 'aria-pressed', String(Boolean(w.cabin)));
    if (this.insideCabin()) { put(info, t('walk.inCabin')); return; }
    const d = Math.hypot(w.x, w.z) * 1000, compass = t('compass8').split(','), dir = compass[Math.round(((Math.atan2(w.x, -w.z) * 180 / Math.PI + 360) % 360) / 45) % 8];
    const where = d < 1 ? t('walk.at') : t('walk.where', { d: number(Math.round(d)), dir });
    const here = w.here ? t('walk.here', { sun: t(w.here.eclipse >= 1 && w.here.sun ? 'walk.sun.eclipse' : w.here.lander ? 'walk.sun.lander' : w.here.sun ? 'walk.sun.lit' : 'walk.sun.shade'), earth: t(w.here.earth ? 'walk.earth.on' : 'walk.earth.off') }) : '';
    put(info, [where, here, w.edge ? t('walk.edge') : ''].filter(Boolean).join(' · '));
  }
  // The helmet and the controls cover the part of the scene left free by the panels; the Sun's glare sits where
  // the Sun is, and grows as it nears the line of sight (none when the relief or the Earth hides it).
  placeWalkOverlay() {
    if (this.view !== 'surface') return;
    const { w, h, fw, fh } = this.free || this.freeArea();
    Object.assign(this.helmet.style, { width: `${fw}px`, height: `${fh}px` });
    const hud = this.walkHud, hw = hud.offsetWidth || 320, hh = hud.offsetHeight || 120;
    // At the bottom of the free area, or above the scene's tool row where they would meet (narrow screens).
    let hx = Math.max(12, Math.min(fw - hw - 12, fw / 2 - hw / 2)), hy = Math.max(12, fh - hh - 10);
    const tools = document.querySelector('.stage-tools')?.getBoundingClientRect(), box = this.container.getBoundingClientRect();
    if (tools?.width) { const tl = tools.left - box.left, tr = tools.right - box.left, tt = tools.top - box.top; if (hx < tr + 8 && hx + hw > tl - 8 && hy + hh > tt - 8) hy = Math.max(12, tt - hh - 10); }
    hud.style.transform = `translate(${hx}px,${hy}px)`;
    const glare = this.helmet.firstElementChild, ghost = glare.nextElementSibling, here = this.walker.here;
    if (!this.result || !this.walker.helmet) { glare.style.opacity = ghost.style.opacity = '0'; return; }
    const sun = v3(this.result.sun.direction), look = this.controls.target.clone().sub(this.camera.position).normalize();
    const lit = (here ? here.sun : this.result.sun.available) ? 1 - (this.result.sun.eclipse || 0) : 0;
    const k = lit * THREE.MathUtils.smoothstep(sun.dot(look), Math.cos(THREE.MathUtils.degToRad(60)), Math.cos(THREE.MathUtils.degToRad(4)));
    const p = this.camera.position.clone().addScaledVector(sun, 100).project(this.camera), sx = (p.x * .5 + .5) * w, sy = (-p.y * .5 + .5) * h;
    Object.assign(glare.style, { left: `${sx}px`, top: `${sy}px`, opacity: String(.9 * k) });
    Object.assign(ghost.style, { left: `${fw - sx}px`, top: `${fh - sy}px`, opacity: String(.7 * k) });
  }
  invalidate() { this.dirty = true; }
  dispose() {
    this.disposed = true; cancelAnimationFrame(this.frame); this.resizeObserver.disconnect(); this.controls.dispose(); this.sky.dispose(); this.groundLight.dispose(); this.renderer.dispose();
    window.removeEventListener('keydown', this.onWalkKey); window.removeEventListener('keyup', this.onWalkKey); window.removeEventListener('blur', this.onWalkBlur);
    this.landing?.dispose(); this.landerMaterials?.dispose(); this.landerEnv?.dispose(); this.helmet.remove(); this.fade.remove(); this.walkHud.remove();
    [...this.siteLabels, ...this.blockLabels, ...this.sitePins.map(p => p.el)].forEach(el => el.remove());
  }
}
