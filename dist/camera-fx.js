import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// The camera of the mission: the Sun as a real disc, auto exposure, lens flare, and the sky behind it all.
//
// Radiance scale (shared with the whole mission): sunlight is a DirectionalLight of intensity 3.2, so the solar
// irradiance is E = 3.2 and a white Lambert surface facing the Sun has radiance 3.2/pi ~ 1. Everything below is
// derived from that one number and from the Sun's apparent magnitude, so stars, Milky Way, corona and flare keep
// their true ratios to sunlit surfaces: Sirius is ~20 stops fainter than sunlit regolith in one pixel, the Milky
// Way ~22 stops. That is why sunlit Apollo frames show a black sky, and why a camera has to open up to see stars.
//
// Pipeline (composer): stage (bodies, Sun disc, spacecraft; linear HDR, alpha = coverage) -> CameraFX.pass
// (meter, adapt, x exposure, flare, Milky Way + stars composited *behind* the scene) -> bloom -> OutputPass -> film.
// The sky is composited after the exposure because its true radiance (1e-8) is below what a half-float buffer
// can hold: it is computed in float inside the shader, already multiplied by the exposure.

export const SOLAR_IRRADIANCE = 3.2;                       // scene units (see above)
const SUN_V = -26.74;                                      // apparent V magnitude of the Sun at 1 AU
const SUN_RADIUS = 959.63 / 206264.806;                    // angular radius at 1 AU (rad): 0.533 deg diameter
// Mean disc radiance E / (pi r^2) = 4.7e4. A half-float buffer and the bloom cannot carry that safely, so the disc
// is drawn ~3.6 stops dimmer (still 12 stops above white, so it clips exactly like a real Sun). Flare, glare and
// corona use the true value: they are computed in float, not read back from the buffer.
const SUN_RADIANCE = SOLAR_IRRADIANCE / (Math.PI * SUN_RADIUS * SUN_RADIUS);
export const SUN_DISC_RADIANCE = 4000;
// Colour of sunlight above the atmosphere (~5900 K chromaticity) in linear sRGB, luminance 1.
const SUN_RGB = [1.097, 0.978, 0.935];
// Integrated starlight: NASA SVS Deep Star Maps 2020 (milkyway_2020, linear, values 0..1, no units). Calibrated so
// the median of the galactic equator (0.066 in the map) is ~200 S10(V) (Leinert et al. 1998: ~200 S10 in the
// plane); 1 S10 = one 10th-mag star per square degree = 2.11e-11 in scene radiance. Sagittarius then comes out
// ~1800 S10 (~19.8 mag/arcsec^2), the poles ~12 S10 (bright stars are left out of that map; they are drawn as points).
export const MILKY_WAY_SCALE = 6.4e-8;
// The stars as a dark-adapted eye sees them on the Moon (a stated licence, like the earthshine boost): 2^19.5 brings
// Sirius from ~20 stops under sunlit regolith to just under it, and the faint ones to the edge of seeing; they follow
// 0.3 of the exposure, so a dark view shows more of them, lit ground fewer, and the glare still hides them near the Sun.
export const EYE_STARS = Object.freeze({ stars: 2 ** 19.5, starAdapt: .3 });

// ---------------------------------------------------------------------------------------------------------------
// Analytic geometry (CPU)

// Area of the solar disc (radius a) covered by an occulting disc (radius b) at angular separation d (all in rad).
// The Sun is 0.27 deg across, so a flat-sky lens formula is exact enough even when the occluder is the whole Earth.
function covered(a, b, d) {
  if (d >= a + b) return 0;
  if (d <= b - a) return 1;
  if (d <= a - b) return (b * b) / (a * a);
  const c1 = Math.min(1, Math.max(-1, (d * d + a * a - b * b) / (2 * d * a))), c2 = Math.min(1, Math.max(-1, (d * d + b * b - a * a) / (2 * d * b)));
  const k = Math.max(0, (-d + a + b) * (d + a - b) * (d - a + b) * (d + a + b));
  return (a * a * Math.acos(c1) + b * b * Math.acos(c2) - 0.5 * Math.sqrt(k)) / (Math.PI * a * a);
}
const _r = new THREE.Vector3();
// Unoccluded fraction of the solar disc seen from cameraPos (world), Sun towards sunDir (unit, world),
// past spheres [{centre: Vector3, radius}] (world units). Occluders are treated as independent (product).
export function sunVisibility(cameraPos, sunDir, spheres = [], distanceAU = 1) {
  const a = SUN_RADIUS / distanceAU; let visible = 1;
  for (const { centre, radius } of spheres) {
    _r.copy(centre).sub(cameraPos); const d = _r.length(); if (d <= radius) return 0;
    const b = Math.asin(radius / d), sep = Math.acos(Math.min(1, Math.max(-1, _r.dot(sunDir) / d)));
    visible *= 1 - covered(a, b, sep); if (visible <= 0) return 0;
  }
  return visible;
}

// Earth's atmosphere on a grazing ray (camera above it): Rayleigh, ozone (Chappuis band) and aerosol extinction.
// Vertical optical depths at the effective wavelengths of the sRGB primaries (610/550/465 nm): Rayleigh
// 0.0088 lambda^-4.05 (Bucholtz 1995 fit); ozone 300 DU, Chappuis cross-sections; aerosol 0.10 at 550 nm,
// Angstrom exponent 1.3. Air mass of a full tangent ray through an exponential layer of scale height H at tangent
// height h: sqrt(2 pi R / H) exp(-h/H) (the Chapman grazing limit). Refraction (the flattened sunrise) is ignored.
const TAU_R = [0.065, 0.099, 0.195], TAU_O = [0.036, 0.028, 0.006], TAU_A = [0.087, 0.100, 0.125];
export function atmosphereTransmittance(heightKm) {
  if (heightKm > 120) return [1, 1, 1];
  const h = Math.max(0, heightKm), mR = 70.7 * Math.exp(-h / 8), mA = 182.6 * Math.exp(-h / 1.2), mO = ozoneAirMass(h);
  return [0, 1, 2].map(i => Math.exp(-(TAU_R[i] * mR + TAU_O[i] * mO + TAU_A[i] * mA)));
}
// Ozone peaks near 22 km: limb (occultation) columns are ~30 vertical columns for tangent heights below ~15 km,
// falling to nothing above ~40 km.
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function ozoneAirMass(h) { return 30 * (1 - smooth(15, 40, h)); }
// Tangent height (km) of the ray from cameraPos along dir above a sphere (Earth), or Infinity if it never grazes it.
export function tangentHeightKm(cameraPos, dir, centre, radius, unitKm = 1000) {
  _r.copy(centre).sub(cameraPos); const t = _r.dot(dir); if (t <= 0) return Infinity;
  return (Math.sqrt(Math.max(0, _r.lengthSq() - t * t)) - radius) * unitKm;
}
// Colour and strength of the sunlight reaching cameraPos through the Earth's limb (1,1,1 in clear space).
// Useful to tint the spacecraft's sunlight at orbital sunrise/sunset.
export function sunlightThroughAtmosphere(cameraPos, sunDir, earthCentre, earthRadius, unitKm = 1000) {
  return atmosphereTransmittance(tangentHeightKm(cameraPos, sunDir, earthCentre, earthRadius, unitKm));
}

// Star colour from B-V: Ballesteros (2012) temperature, then a blackbody through the CIE 1931 observer
// (Wyman, Sloan & Shirley 2013 analytic fit) into linear sRGB, normalised to luminance 1 (V ~ luminance).
const lobe = (x, m, s1, s2) => Math.exp(-0.5 * ((x - m) / (x < m ? s1 : s2)) ** 2);
function blackbodyRGB(T) {
  let X = 0, Y = 0, Z = 0;
  for (let l = 380; l <= 780; l += 5) {
    const p = 1 / (l ** 5 * (Math.exp(1.4388e7 / (l * T)) - 1));
    X += p * (1.056 * lobe(l, 599.8, 37.9, 31) + 0.362 * lobe(l, 442, 16, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2));
    Y += p * (0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1));
    Z += p * (1.217 * lobe(l, 437, 11.8, 36) + 0.681 * lobe(l, 459, 26, 13.8));
  }
  return [3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, -0.969266 * X + 1.8760108 * Y + 0.041556 * Z, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z].map(c => Math.max(0, c / Y));
}
const bvTemperature = bv => 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));

// ---------------------------------------------------------------------------------------------------------------
// GLSL shared by the passes

// Solar limb darkening, Allen's law I(mu)/I(1) = 1 - u - v + u mu + v mu^2 with u, v at 610/550/465 nm
// (polynomial fit to Pierce & Slaughter / Neckel & Labs data, as in SolarSoft darklimb_correct). Disc mean ~0.80.
const GLSL_SUN = /* glsl */`
const vec3 LD_U = vec3(.845, .914, .976), LD_V = vec3(-.206, -.215, -.175);
vec3 limbDarkening(float rho){ float mu = sqrt(max(0., 1. - rho * rho)); return 1. - LD_U - LD_V + LD_U * mu + LD_V * mu * mu; }
const vec3 LD_MEAN = vec3(.821, .802, .760);
`;
const GLSL_ATMOSPHERE = /* glsl */`
uniform vec3 uEarthCentre; uniform float uEarthRadius, uUnitKm;
vec3 atmosphereT(vec3 p, vec3 d){
  if (uEarthRadius <= 0.) return vec3(1.);
  vec3 oc = uEarthCentre - p; float t = dot(oc, d); if (t <= 0.) return vec3(1.);
  float h = (sqrt(max(0., dot(oc, oc) - t * t)) - uEarthRadius) * uUnitKm; if (h > 120.) return vec3(1.);
  h = max(h, 0.);
  float mR = 70.7 * exp(-h / 8.), mA = 182.6 * exp(-h / 1.2), mO = 30. * (1. - smoothstep(15., 40., h));
  return exp(-(vec3(.065, .099, .195) * mR + vec3(.036, .028, .006) * mO + vec3(.087, .1, .125) * mA));
}`;
const GLSL_MILKY_WAY = /* glsl */`
uniform sampler2D uMilkyWay; uniform mat3 uSceneToJ2000; uniform float uMilkyWayScale;
// Equirectangular in J2000 RA/Dec, RA = 0 at the centre and increasing to the left (checked against Sirius,
// Canopus, Arcturus, Vega, Rigel, Betelgeuse in the SVS star map). The texture is sRGB-encoded linear data:
// the sampler decodes it back to linear, so it is used as is (no squaring).
vec3 milkyWay(vec3 w){
  vec3 j = uSceneToJ2000 * w; float ra = atan(j.y, j.x), dec = asin(clamp(j.z, -1., 1.));
  return texture2D(uMilkyWay, vec2(.5 - ra / 6.28318530718, .5 + dec / 3.14159265359)).rgb * uMilkyWayScale;
}`;
const VERT_QUAD = 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';
// Full-screen pass material: no depth test or write (the composer's MSAA buffers keep depth from earlier passes).
const quadMaterial = o => new THREE.ShaderMaterial({ depthTest: false, depthWrite: false, vertexShader: VERT_QUAD, ...o });

// ---------------------------------------------------------------------------------------------------------------
// The Sun: a disc of the right size with limb darkening, the K+F corona around it, both seen through the Earth's
// atmosphere when the line of sight grazes it. Drawn first in the bodies pass (renderOrder -100, no depth test or
// write): everything opaque paints over it, so the Earth, the Moon and the spacecraft cut it with their own
// antialiased edges, whatever the near plane is.
export function createSun({ logarithmicDepthBuffer = false } = {}) {
  const halo = 24; // quad half-size in solar radii: the corona is drawn out to ~24 R_sun
  const material = new THREE.ShaderMaterial({
    uniforms: { uSunDir: { value: new THREE.Vector3(1, 0, 0) }, uRadius: { value: SUN_RADIUS }, uHalo: { value: halo },
      uDisc: { value: SUN_DISC_RADIANCE }, uCorona: { value: SUN_RADIANCE }, uColor: { value: new THREE.Vector3(...SUN_RGB) },
      uEarthCentre: { value: new THREE.Vector3() }, uEarthRadius: { value: 0 }, uUnitKm: { value: 1000 } },
    vertexShader: /* glsl */`
      ${logarithmicDepthBuffer ? '#include <common>\n#include <logdepthbuf_pars_vertex>' : ''}
      uniform vec3 uSunDir; uniform float uRadius, uHalo; varying vec2 vXY; varying vec3 vDir;
      void main(){
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec2 xy = position.xy * uHalo; vXY = xy;                       // tangent-plane offset in solar radii
        vec3 d = normalize(uSunDir + (right * xy.x + up * xy.y) * uRadius); vDir = d;
        // A direction, not a point: projected at infinity and pinned to the far plane, whatever near/far are.
        vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * d, 0.); clip.z = clip.w * .99999; gl_Position = clip;
        ${logarithmicDepthBuffer ? '#include <logdepthbuf_vertex>' : ''}
      }`,
    fragmentShader: /* glsl */`
      ${logarithmicDepthBuffer ? '#include <logdepthbuf_pars_fragment>' : ''}
      uniform float uDisc, uCorona; uniform vec3 uColor; varying vec2 vXY; varying vec3 vDir;
      ${GLSL_SUN}${GLSL_ATMOSPHERE}
      void main(){
        float rho = length(vXY), aa = max(fwidth(rho), 1e-4), inside = 1. - smoothstep(1. - aa, 1. + aa, rho);
        vec3 disc = uDisc / LD_MEAN * limbDarkening(min(rho, 1.)) * inside;
        // K+F corona, Baumbach (1937): I/I_disc = 1e-6 (0.0532 r^-2.5 + 1.425 r^-7 + 2.565 r^-17), r in solar radii.
        // Physical radiance (not compressed): ~0.2 at the limb, i.e. a sunlit-grey level, exactly why eclipse
        // photographers expose the inner corona near 'sunny 16'. Visible only once the disc itself is hidden.
        float r = max(rho, 1.), corona = 1e-6 * (.0532 * pow(r, -2.5) + 1.425 * pow(r, -7.) + 2.565 * pow(r, -17.));
        float fade = 1. - smoothstep(.7 * ${halo.toFixed(1)}, ${halo.toFixed(1)}, rho);
        vec3 c = (disc + uCorona * corona * fade * (1. - inside)) * uColor * atmosphereT(cameraPosition, normalize(vDir));
        gl_FragColor = vec4(min(c, vec3(30000.)), inside);
        ${logarithmicDepthBuffer ? '#include <logdepthbuf_fragment>' : ''}
      }`,
    // Plain additive (one, one) also for alpha: the disc marks itself as covering the sky, the corona does not.
    depthTest: false, depthWrite: false, transparent: false, toneMapped: false, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor
  });
  const sun = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  sun.frustumCulled = false; sun.renderOrder = -100; sun.name = 'sun';
  return sun;
}

// Milky Way on a sphere mesh, for scenes that do not use CameraFX. Natural colour, true radiance x uGain
// (uGain = the exposure; ~1e5..1e6 to see it, which is the honest answer).
export function milkyWayMaterial(texture, { gain = 1, sceneToJ2000 = new THREE.Matrix3().set(1, 0, 0, 0, 0, -1, 0, 1, 0) } = {}) {
  prepareSkyTexture(texture);
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, toneMapped: false, fog: false,
    uniforms: { uMilkyWay: { value: texture }, uSceneToJ2000: { value: sceneToJ2000 }, uMilkyWayScale: { value: MILKY_WAY_SCALE }, uGain: { value: gain } },
    vertexShader: 'varying vec3 vDir;void main(){vDir=(modelMatrix*vec4(position,0.)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `uniform float uGain;varying vec3 vDir;${GLSL_MILKY_WAY}void main(){gl_FragColor=vec4(milkyWay(normalize(vDir))*uGain,1.);}`
  });
}
function prepareSkyTexture(texture) {
  // No mipmaps (the RA seam would pick the smallest mip); repeat in RA so bilinear filtering crosses the seam.
  texture.colorSpace = THREE.SRGBColorSpace; texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping; if (texture.image) texture.needsUpdate = true; // a loading texture is uploaded on load
}

// ---------------------------------------------------------------------------------------------------------------
// Auto exposure + flare + sky, one composer pass.

const METER = { w: 64, h: 32 };
const fullTarget = (w, h, type) => new THREE.WebGLRenderTarget(w, h, { type, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });

export class CameraFX {
  constructor(renderer, { camera = null, milkyWay = null, stars = null, blades = 5, halfFloat = false, initialEV = null, sunOptions = {} } = {}) {
    this.renderer = renderer; this.camera = camera;
    const float = !halfFloat && renderer.extensions.has('EXT_color_buffer_float'), type = float ? THREE.FloatType : THREE.HalfFloatType;
    // Metering knobs. Exposure X multiplies scene radiance before the bloom; EV = log2 X.
    this.params = {
      key: 0.04,        // light-weighted mean luminance at and above which the camera stays at X = 1 ('sunny 16')
      slope: 0.8,       // fraction of a darkening the camera compensates: 10 stops darker scene -> shown 2 stops darker
      coverage: 0.25,   // small lit objects may overexpose: +0.25 EV per halving of the lit area
      // X never below 1 (sunlit frames keep today's look); up to 2^22 = EV100 -7, a Milky Way exposure (ISO 6400,
      // f/2.8, ~30 s), reached only when nothing in the frame is lit.
      minEV: 0, maxEV: 22, bias: 0,
      saturation: 4,    // the meter's own saturation: the Sun and engine cores count as 4, not 4000
      tauBright: 0.22, tauDark: 1.3, // adaptation time constants (s): fast when the scene brightens, slower when it darkens
      flare: 1, glare: 1, ghosts: 1, spikes: 1, halo: 1, veil: 1, blades, bladeAngle: 0.31,
      stars: 1, milkyWay: 1,
      // How much of the exposure the stars follow: 1 = a camera (true ratios to sunlit surfaces); below 1, the eye. A
      // dark-adapted eye does not take its stars ~20 stops down when lit ground is in view: with a stars gain (a stated
      // licence) they stay on the black sky, brighter as the view darkens, and still go in the glare near the Sun.
      starAdapt: 1,
      // Film saturation after exposure: the emulsion (or sensor) cannot record more than this, and the bloom pass
      // (UnrealBloom, made for highlights of ~1-10) would turn a 4000-bright disc into a screen-wide blob. The Sun's
      // real glare comes from the flare below, computed from its true flux.
      clip: 24
    };
    this.floor = float ? 2 ** -33 : 2 ** -14; // meter floor: a black frame reads as this luminance (-> maxEV)
    this.fixed = null; this.reset = true; this.last = 0; this.touched = -1e9; this.size = new THREE.Vector2(1, 1);
    this.initialEV = Number.isFinite(initialEV) ? initialEV : null;
    this.sun = createSun(sunOptions);
    this.sceneToJ2000 = new THREE.Matrix3().set(1, 0, 0, 0, 0, -1, 0, 1, 0); // mission world (x, y=north, z) -> J2000
    this.j2000ToScene = this.sceneToJ2000.clone().transpose();
    this.sunDir = new THREE.Vector3(1, 0, 0); this.sunScreen = new THREE.Vector3(); this.sunOn = false; this.analytic = 1;
    this.externalVisibility = 1; this.offscreenVisibility = 0;
    this.moments = [fullTarget(METER.w, METER.h, type), fullTarget(8, 4, type), fullTarget(1, 1, type)];
    this.state = [fullTarget(1, 1, type), fullTarget(1, 1, type)]; this.current = 0;
    const blackSky = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); blackSky.needsUpdate = true; this.blackSky = blackSky;
    this.quad = new FullScreenQuad(null);
    this.meterMaterial = quadMaterial({
      uniforms: { tHdr: { value: null }, uFloor: { value: this.floor }, uSat: { value: 4 }, uGrid: { value: new THREE.Vector2(METER.w, METER.h) } },
      // Four moments per cell (16 bilinear taps, centre-weighted): w(L), w(L log2 L), w(L^2), w(log2 L).
      fragmentShader: /* glsl */`
        uniform sampler2D tHdr; uniform float uFloor, uSat; uniform vec2 uGrid; varying vec2 vUv;
        void main(){
          vec4 m = vec4(0.); vec2 cell = floor(vUv * uGrid);
          for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
            vec2 uv = (cell + (vec2(x, y) + .5) / 4.) / uGrid;
            float L = dot(texture2D(tHdr, uv).rgb, vec3(.2126, .7152, .0722));
            if (isnan(L) || isinf(L)) L = 0.;
            L = clamp(L, 0., uSat) + uFloor;
            vec2 c = uv - .5; float w = 1.25 - .9 * dot(c, c) * 2.;   // mild centre weighting, mean ~1
            float l2 = log2(L); m += w * vec4(L, L * l2, L * L, l2);
          }
          gl_FragColor = m / 16.;
        }`
    });
    const reduce = (bx, by) => quadMaterial({ uniforms: { t: { value: null } },
      fragmentShader: `uniform sampler2D t;void main(){ivec2 o=ivec2(gl_FragCoord.xy)*ivec2(${bx},${by});vec4 s=vec4(0.);for(int y=0;y<${by};y++)for(int x=0;x<${bx};x++)s+=texelFetch(t,o+ivec2(x,y),0);gl_FragColor=s/${(bx * by).toFixed(1)};}` });
    this.reduceMaterials = [reduce(8, 8), reduce(8, 4)];
    this.adaptMaterial = quadMaterial({
      uniforms: { tMoments: { value: null }, tPrev: { value: null }, tHdr: { value: null }, uKey: { value: .04 }, uSlope: { value: .8 }, uCoverage: { value: .25 }, uBias: { value: 0 },
        uMinEV: { value: 0 }, uMaxEV: { value: 20 }, uDt: { value: 0 }, uTauBright: { value: .22 }, uTauDark: { value: 1.3 }, uReset: { value: 1 }, uFixed: { value: -1 },
        uSunUv: { value: new THREE.Vector2() }, uSunR: { value: new THREE.Vector2() }, uSunOn: { value: 0 }, uDisc: { value: SUN_DISC_RADIANCE }, uColor: { value: new THREE.Vector3(...SUN_RGB) },
        uInitialEV: { value: -1000 }, uVisibility: { value: 1 }, uOffscreenVisibility: { value: 0 } },
      fragmentShader: /* glsl */`
        uniform sampler2D tMoments, tPrev, tHdr; uniform float uKey, uSlope, uCoverage, uBias, uMinEV, uMaxEV, uDt, uTauBright, uTauDark, uReset, uFixed, uSunOn, uDisc, uInitialEV, uVisibility, uOffscreenVisibility;
        uniform vec2 uSunUv, uSunR; uniform vec3 uColor;
        ${GLSL_SUN}
        void main(){
          vec4 m = texelFetch(tMoments, ivec2(0), 0);
          // Light-weighted log mean: the typical luminance of whatever carries the light in the frame, so the
          // camera exposes for the lit subject however small it is (and opens up when nothing is lit) ...
          float evLight = m.y / max(m.x, 1e-30);
          // ... corrected by the participation ratio (sum L)^2 / (N sum L^2) = the fraction of the frame that carries
          // that light, so a tiny lit speck may overexpose a little, as with a matrix meter.
          float cover = clamp(m.x * m.x / max(m.z, 1e-30), 1e-4, 1.);
          float evM = evLight + uCoverage * log2(cover);
          float target = clamp(uSlope * (log2(uKey) - evM) + uBias, uMinEV, uMaxEV);
          float ev = texelFetch(tPrev, ivec2(0), 0).r;
          if (uReset > .5 || isnan(ev) || isinf(ev)) ev = uInitialEV > -100. ? clamp(uInitialEV, uMinEV, uMaxEV) : target;
          else ev += (target - ev) * (1. - exp(-uDt / (target < ev ? uTauBright : uTauDark)));
          if (uFixed > -100.) ev = uFixed;
          // How much of the solar disc reaches the film, per channel: the disc as it was drawn in the HDR buffer
          // (already cut by the Moon, the Earth or the spacecraft, and reddened by the atmosphere), summed over
          // taps and divided by what an unobstructed disc would give. Feeds the flare.
          vec3 seen = vec3(0.), full = vec3(0.);
          // 10x10 taps over 1.25 disc radii, so light spread by the antialiased edge is counted too.
          if (uSunOn > .5) for (int y = 0; y < 10; y++) for (int x = 0; x < 10; x++) {
            vec2 q = ((vec2(x, y) + .5) / 5. - 1.) * 1.25; float rho = length(q);
            vec3 expect = rho < 1. ? uDisc / LD_MEAN * limbDarkening(rho) * uColor : vec3(0.);
            vec2 uv = uSunUv + q * uSunR; full += expect;
            if (all(greaterThanEqual(uv, vec2(0.))) && all(lessThanEqual(uv, vec2(1.)))) seen += min(texture2D(tHdr, uv).rgb, vec3(uDisc * 1.6));
            else seen += expect * uOffscreenVisibility;
          }
          vec3 vis = clamp(seen / max(full, vec3(1e-6)), 0., 1.) * uVisibility;
          gl_FragColor = vec4(ev, vis);
        }`
    });
    this.applyMaterial = quadMaterial({
      uniforms: { tDiffuse: { value: null }, tState: { value: null }, uClip: { value: 20000 },
        uMilkyWay: { value: blackSky }, uSceneToJ2000: { value: this.sceneToJ2000 }, uMilkyWayScale: { value: MILKY_WAY_SCALE }, uSky: { value: 1 },
        uCamRot: { value: new THREE.Matrix3() }, uTan: { value: new THREE.Vector2(1, 1) },
        uFlare: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uSunPx: { value: new THREE.Vector2() }, uSunRpx: { value: 5 }, uCenterPx: { value: new THREE.Vector2() },
        uPhi: { value: 0 }, uGlare: { value: 1 }, uGhosts: { value: 1 }, uSpikes: { value: 1 }, uHalo: { value: 1 }, uVeil: { value: 1 }, uBlades: { value: blades }, uBladeAngle: { value: .31 } },
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse, tState; uniform float uClip, uSky, uFlare, uSunRpx, uPhi, uGlare, uGhosts, uSpikes, uHalo, uVeil, uBlades, uBladeAngle;
        uniform mat3 uCamRot; uniform vec2 uTan, uRes, uSunPx, uCenterPx; varying vec2 vUv;
        ${GLSL_MILKY_WAY}
        // Image of the iris (N straight blades, slightly rounded): ghosts are defocused pictures of the aperture.
        float iris(vec2 p, float r){
          float a = atan(p.y, p.x) - uBladeAngle, s = 6.28318530718 / uBlades;
          float edge = cos(s * .5) / cos(mod(a + s * .5, s) - s * .5);   // polygon radius in this direction
          float d = length(p) / (r * mix(edge, 1., .6));
          return 1. - smoothstep(.78, 1., d);
        }
        vec3 ghost(vec2 px, float k, float radius, float energy, vec3 tint){
          vec2 c = uCenterPx + k * (uSunPx - uCenterPx); float r = radius * uRes.y;
          if (dot(px - c, px - c) > r * r) return vec3(0.);
          float shape = iris(px - c, r);
          float rim = 1. + .35 * smoothstep(.6, .95, length(px - c) / r);   // slightly brighter rim, as in real ghosts
          return tint * energy / (3.14159 * r * r) * shape * rim;
        }
        void main(){
          vec4 src = texture2D(tDiffuse, vUv); vec4 st = texture2D(tState, vec2(.5));
          // Exposure, then the film's shoulder: linear up to a knee, then an exponential roll-off to saturation
          // per channel (a deep orange Sun saturates to yellow-white in the core, as in ISS sunrise frames).
          float X = exp2(st.r), knee = .25 * uClip; vec3 c = src.rgb * X;
          c = mix(c, knee + (uClip - knee) * (1. - exp(-(c - knee) / (uClip - knee))), step(knee, c));
          // Sky behind the scene: alpha is the coverage written by the bodies and the spacecraft (MSAA-resolved).
          float open = 1. - clamp(src.a, 0., 1.);
          if (uSky > 0. && open > 0.) {
            vec2 ndc = vUv * 2. - 1.; vec3 dir = normalize(uCamRot * vec3(ndc * uTan, -1.));
            c += milkyWay(dir) * X * uSky * open;
          }
          if (uFlare > 0.) {
            vec3 F = uPhi * X * st.gba;   // solar flux reaching the film (radiance x pixels), per channel
            vec2 px = gl_FragCoord.xy, p = px - uSunPx; float r2 = dot(p, p), r = sqrt(r2), H = uRes.y;
            vec3 add = vec3(0.);
            // Glare (aureole): scatter from lens surfaces and dust, Harvey-like r^-2 profile, ~0.2% of the light.
            add += F * 2e-3 / 6.2832 / (r2 + 9. * uSunRpx * uSunRpx) * uGlare;
            // Veiling glare: light bounced around the barrel and film, spread over the whole frame (~0.2%).
            add += F * 2e-3 / (uRes.x * uRes.y) * uVeil;
            // Diffraction starburst: each straight blade edge throws a streak along its normal; N odd -> 2N spikes.
            // Straight-edge diffraction falls as 1/r^2 and scales with wavelength^2 (redder far out).
            bool odd = mod(uBlades, 2.) > .5;
            float count = odd ? 2. * uBlades : uBlades, step = (odd ? 3.14159265 : 6.2831853) / uBlades;
            float r1 = 2.5 * uSunRpx, spike = 0.;
            // Skip the loop where even an on-axis spike would be below ~1e-3 (no visible contribution).
            float reach = sqrt(max(0., F.g * 1e-4 / count * r1 / 1.755 / 1e-3));
            for (int i = 0; i < 18; i++) {
              if (r > reach) break;
              if (float(i) >= count) break;
              float a = uBladeAngle + float(i) * step;
              vec2 d = vec2(cos(a), sin(a)); float along = dot(p, d); if (along <= 0.) continue;
              float perp = abs(p.x * d.y - p.y * d.x);
              spike += r1 / (along * along + r1 * r1) * exp(-perp * perp / .98) / 1.755;
            }
            add += F * vec3(1.12, 1., .82) * 1e-4 / count * spike * uSpikes;
            // Halo: a large soft disc around the Sun, the film/reseau-plate reflection seen in Apollo Hasselblad
            // frames (e.g. AS14-66-9306), ~0.2% of the light; warm, with a soft edge.
            float hr = .155 * H, hd = r / hr;
            add += F * vec3(1., .9, .7) * 2.2e-3 / (3.14159 * hr * hr) * (1. - smoothstep(.75, 1., hd)) * (.75 + .25 * hd) * uHalo;
            // Ghosts on the line from the Sun through the centre of the frame: defocused images of the iris after two
            // reflections at single-coated surfaces (~1e-4 each), tinted by the coatings (magenta/violet, amber).
            add += uGhosts * (ghost(px, -.92, .052, 1.2e-4, vec3(.7, .72, 1.18))
                            + ghost(px, -1.18, .040, .8e-4, vec3(1.02, .8, 1.15))
                            + ghost(px, -.38, .022, .3e-4, vec3(1.1, .96, .7))
                            + ghost(px, .52, .014, .2e-4, vec3(.9, 1.05, .9))
                            + ghost(px, .9, .0055, .22e-4, vec3(1.))) * F;
            c += add * uFlare;
          }
          gl_FragColor = vec4(min(c, vec3(uClip * 2.)), src.a);
        }`
    });
    // Stars: HYG catalogue points at true irradiance, PSF = Gaussian core + Moffat wing, drawn behind the scene.
    this.starScene = new THREE.Scene();
    this.starMaterial = new THREE.ShaderMaterial({
      uniforms: { tState: { value: null }, uJ2000ToScene: { value: this.j2000ToScene }, uPx: { value: 1e-3 }, uSigma: { value: .6 }, uGain: { value: 1 }, uAdapt: { value: 1 } },
      vertexShader: /* glsl */`
        attribute float aIrradiance; attribute vec3 aColor; uniform sampler2D tState; uniform mat3 uJ2000ToScene; uniform float uPx, uSigma, uGain, uAdapt;
        varying vec3 vColor; varying float vSize, vCore, vWing;
        const float HALO = .04, A = 1.6;   // wing energy fraction and Moffat core (px), beta = 1.5
        void main(){
          float X = exp2(texture2D(tState, vec2(.5)).r * uAdapt) * uGain;
          float flux = aIrradiance * X / (uPx * uPx);                       // radiance x pixels on the film
          vCore = flux * (1. - HALO) / (6.2832 * uSigma * uSigma); vWing = flux * HALO * .5 / (3.1416 * A * A);
          float t = 2e-4;                                                   // below this a pixel is black after tone mapping
          float rc = vCore > t ? uSigma * sqrt(2. * log(vCore / t)) : 0., rw = vWing > t ? A * sqrt(pow(vWing / t, 1. / 1.5) - 1.) : 0.;
          float radius = min(max(rc, rw), 40.); vSize = 2. * radius + 2.; vColor = aColor;
          vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * (uJ2000ToScene * position), 0.);
          clip.z = clip.w * .99999; gl_Position = clip; gl_PointSize = radius > .3 ? vSize : 0.;
        }`,
      fragmentShader: /* glsl */`
        uniform float uSigma; varying vec3 vColor; varying float vSize, vCore, vWing;
        void main(){
          float r = length(gl_PointCoord - .5) * vSize;
          float L = vCore * exp(-r * r / (2. * uSigma * uSigma)) + vWing * pow(1. + r * r / 2.56, -1.5);
          gl_FragColor = vec4(vColor * min(L, 4000.), 0.);
        }`,
      // dst += src * (1 - coverage): stars only where the scene left the sky open; alpha is kept.
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneMinusDstAlphaFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor, depthTest: false, depthWrite: false, toneMapped: false
    });
    this.pass = new CameraFXPass(this);
    if (milkyWay) this.setMilkyWay(milkyWay);
    if (stars) this.setStars(stars);
  }
  // Optional (recommended): the bodies pass renders into this multisampled target and the composer's own buffers
  // stay single-sampled. On integrated GPUs every full-screen pass written into a 4x MSAA half-float buffer costs
  // ~4 ms of bandwidth (measured: OutputPass 4.4 ms into MSAA vs 0.4 ms for the film pass to the canvas); only the
  // geometry needs the samples. CameraFX reads this target and writes the composer's first buffer.
  createStageTarget({ samples = 4, type = THREE.HalfFloatType } = {}) {
    this.stage?.dispose(); this.stage = new THREE.WebGLRenderTarget(Math.max(1, this.size.x), Math.max(1, this.size.y), { type, samples });
    return this.stage;
  }
  setMilkyWay(texture) { prepareSkyTexture(texture); this.applyMaterial.uniforms.uMilkyWay.value = texture; }
  setStars(data) {
    if (this.stars) { this.starScene.remove(this.stars); this.stars.geometry.dispose(); }
    const list = data.stars, n = list.length, position = new Float32Array(n * 3), color = new Float32Array(n * 3), irradiance = new Float32Array(n);
    const table = new Map(), colorOf = bv => { const key = Math.round(Math.min(2, Math.max(-.4, bv)) * 20); if (!table.has(key)) table.set(key, blackbodyRGB(bvTemperature(key / 20))); return table.get(key); };
    list.forEach(([ra, dec, mag, bv], i) => {
      const a = THREE.MathUtils.degToRad(ra), d = THREE.MathUtils.degToRad(dec);
      position.set([Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)], i * 3);
      color.set(colorOf(bv ?? .6), i * 3);
      irradiance[i] = SOLAR_IRRADIANCE * 10 ** (-0.4 * (mag - SUN_V));   // Pogson, anchored on the Sun
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3)); g.setAttribute('aColor', new THREE.BufferAttribute(color, 3)); g.setAttribute('aIrradiance', new THREE.BufferAttribute(irradiance, 1));
    this.stars = new THREE.Points(g, this.starMaterial); this.stars.frustumCulled = false; this.stars.layers.enableAll(); this.starScene.add(this.stars);
  }
  // Scene axes from J2000: rows are the scene x, y, z axes written as J2000 vectors (same convention as stars.js
  // setRotationRows). Mission world: [1,0,0], [0,0,1], [0,-1,0].
  setSkyRows(rx, ry, rz) {
    this.j2000ToScene.set(rx[0], rx[1], rx[2], ry[0], ry[1], ry[2], rz[0], rz[1], rz[2]);
    this.sceneToJ2000.copy(this.j2000ToScene).transpose();
  }
  setFixedExposure(x = null) { this.fixed = x == null ? null : Math.log2(Math.max(1e-6, x)); }
  resetAdaptation() { this.reset = true; }
  // Adaptation runs on the GPU: keep drawing for a while after the last real change so it can settle.
  touch(now = performance.now()) { this.touched = now; }
  settling(now = performance.now()) { return this.fixed == null && now - this.touched < 1000 * 4 * this.params.tauDark; }
  // Per frame, before composer.render(): camera (matrices up to date), Sun direction (unit, scene frame),
  // occluding spheres [{centre, radius}] for the analytic visibility, the Earth {centre, radius} for the
  // atmosphere (or null), and the distance to the Sun in AU (disc size).
  // sunVisibility is a terrain-disc fraction (0..1), multiplied by the HDR disc samples. Offscreen visibility
  // is opt-in: only a caller with a conservative camera-height terrain horizon should enable near-frame glare.
  update(camera, { sunDir, spheres = [], earth = null, distanceAU = 1, unitKm = 1000, sunVisibility: visibility = 1, offscreenVisibility = 0 } = {}) {
    this.camera = camera; if (sunDir) this.sunDir.copy(sunDir).normalize();
    const u = this.sun.material.uniforms; u.uSunDir.value.copy(this.sunDir); u.uRadius.value = SUN_RADIUS / distanceAU; u.uUnitKm.value = unitKm;
    u.uEarthRadius.value = earth ? earth.radius : 0; if (earth) u.uEarthCentre.value.copy(earth.centre);
    this.analytic = sunVisibility(camera.position, this.sunDir, spheres, distanceAU);
    this.externalVisibility = Number.isFinite(visibility) ? THREE.MathUtils.clamp(visibility, 0, 1) : 0;
    this.offscreenVisibility = Number.isFinite(offscreenVisibility) ? THREE.MathUtils.clamp(offscreenVisibility, 0, 1) : 0;
    this.flux = SOLAR_IRRADIANCE / (distanceAU * distanceAU);
    this.distanceAU = distanceAU;
  }
  dispose() {
    for (const t of [...this.moments, ...this.state]) t.dispose();
    for (const m of [this.meterMaterial, ...this.reduceMaterials, this.adaptMaterial, this.applyMaterial, this.starMaterial, this.sun.material]) m.dispose();
    this.sun.geometry.dispose(); this.stars?.geometry.dispose(); this.blackSky.dispose(); this.quad.dispose(); this.stage?.dispose();
  }
}

const _v = new THREE.Vector3();
class CameraFXPass extends Pass {
  constructor(fx) { super(); this.fx = fx; this.needsSwap = true; }
  setSize(width, height) { this.fx.size.set(width, height); this.fx.stage?.setSize(width, height); }
  render(renderer, writeBuffer, readBuffer) {
    const fx = this.fx, p = fx.params, camera = fx.camera, now = performance.now(), dt = fx.last ? Math.min(.1, Math.max(0, (now - fx.last) / 1000)) : 0; fx.last = now;
    const W = fx.size.x, H = fx.size.y, hdr = (fx.stage || readBuffer).texture, autoClear = renderer.autoClear; renderer.autoClear = false;
    // Where the Sun is on the film and how big.
    let sunOn = false; const fovY = THREE.MathUtils.degToRad(camera.getEffectiveFOV()), tanY = Math.tan(fovY / 2), tanX = tanY * camera.aspect, pxAngle = 2 * tanY / H;
    _v.copy(fx.sunDir).transformDirection(camera.matrixWorldInverse);
    const rSun = SUN_RADIUS / (fx.distanceAU || 1), rPx = rSun / pxAngle;
    if (_v.z < 0) {
      const x = (_v.x / -_v.z) / tanX, y = (_v.y / -_v.z) / tanY; fx.sunScreen.set((x * .5 + .5) * W, (y * .5 + .5) * H, 0);
      const m = rPx + .2 * H; sunOn = fx.analytic > 0 && fx.sunScreen.x > -m && fx.sunScreen.x < W + m && fx.sunScreen.y > -m && fx.sunScreen.y < H + m;
    }
    fx.sunOn = sunOn && fx.sun.visible;
    // 1. meter: 64x32 cells -> 8x4 -> 1x1 (four moments, float targets, no readback)
    const q = fx.quad, mu = fx.meterMaterial.uniforms; mu.tHdr.value = hdr; mu.uFloor.value = fx.floor; mu.uSat.value = p.saturation;
    q.material = fx.meterMaterial; renderer.setRenderTarget(fx.moments[0]); q.render(renderer);
    fx.reduceMaterials[0].uniforms.t.value = fx.moments[0].texture; q.material = fx.reduceMaterials[0]; renderer.setRenderTarget(fx.moments[1]); q.render(renderer);
    fx.reduceMaterials[1].uniforms.t.value = fx.moments[1].texture; q.material = fx.reduceMaterials[1]; renderer.setRenderTarget(fx.moments[2]); q.render(renderer);
    // 2. adapt (ping-pong 1x1: R = EV, GBA = visible fraction of the solar disc per channel)
    const prev = fx.state[fx.current], next = fx.state[1 - fx.current], au = fx.adaptMaterial.uniforms;
    au.uKey.value = p.key; au.uSlope.value = p.slope; au.uCoverage.value = p.coverage; au.uBias.value = p.bias; au.uMinEV.value = p.minEV; au.uMaxEV.value = p.maxEV;
    au.uTauBright.value = p.tauBright; au.uTauDark.value = p.tauDark; au.uDt.value = dt; au.uReset.value = fx.reset ? 1 : 0; au.uFixed.value = fx.fixed ?? -1000;
    au.uInitialEV.value = fx.initialEV ?? -1000; au.uVisibility.value = fx.externalVisibility; au.uOffscreenVisibility.value = fx.offscreenVisibility;
    au.tMoments.value = fx.moments[2].texture; au.tPrev.value = prev.texture; au.tHdr.value = hdr; au.uSunOn.value = fx.sunOn ? 1 : 0;
    au.uSunUv.value.set(fx.sunScreen.x / W, fx.sunScreen.y / H); au.uSunR.value.set(rPx / W, rPx / H); au.uDisc.value = fx.sun.material.uniforms.uDisc.value;
    q.material = fx.adaptMaterial; renderer.setRenderTarget(next); q.render(renderer);
    fx.current = 1 - fx.current; fx.reset = false;
    // 3. apply exposure, flare and sky into the composer's next buffer
    const a = fx.applyMaterial.uniforms; a.tDiffuse.value = hdr; a.tState.value = next.texture; a.uClip.value = p.clip; a.uSky.value = p.milkyWay;
    a.uCamRot.value.setFromMatrix4(camera.matrixWorld); a.uTan.value.set(tanX, tanY);
    a.uRes.value.set(W, H); a.uCenterPx.value.set(W / 2, H / 2); a.uSunPx.value.set(fx.sunScreen.x, fx.sunScreen.y); a.uSunRpx.value = rPx;
    // Solar flux in 'radiance x pixels': irradiance divided by the solid angle of one pixel.
    a.uPhi.value = (fx.flux ?? SOLAR_IRRADIANCE) / (pxAngle * pxAngle); a.uFlare.value = fx.sunOn ? p.flare : 0;
    a.uGlare.value = p.glare; a.uGhosts.value = p.ghosts; a.uSpikes.value = p.spikes; a.uHalo.value = p.halo; a.uVeil.value = p.veil; a.uBlades.value = p.blades; a.uBladeAngle.value = p.bladeAngle;
    q.material = fx.applyMaterial; renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer); q.render(renderer);
    if (fx.stars && p.stars > 0) {
      const s = fx.starMaterial.uniforms; s.tState.value = next.texture; s.uPx.value = pxAngle; s.uSigma.value = .6 * Math.max(1, renderer.getPixelRatio()); s.uGain.value = p.stars; s.uAdapt.value = p.starAdapt ?? 1;
      const layers = camera.layers.mask; camera.layers.enableAll(); renderer.render(fx.starScene, camera); camera.layers.mask = layers;
    }
    renderer.autoClear = autoClear;
  }
}
