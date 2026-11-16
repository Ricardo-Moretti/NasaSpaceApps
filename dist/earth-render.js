// The Earth and its atmosphere, physically based, for every distance the mission flies.
//
// Atmosphere: Hillaire 2020, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique" (EGSR).
// At startup the GPU computes the transmittance LUT, the multiple-scattering LUT (and a sky-irradiance table). Each
// frame a sky-view LUT ray marches single scattering (Rayleigh, Mie, ozone absorption, planet shadow) plus Hillaire's
// multiple-scattering term along every view direction of the camera, to the top of the atmosphere or to the ground;
// pixels read it (aerial perspective of the ground included). Earth parameters of the paper, in km: ground
// EARTH_RADIUS, top +100 km, Rayleigh (5.802, 13.558, 33.1)e-3 /km with an 8 km scale height, Mie 3.996e-3 /km
// scattering and 4.40e-3 /km extinction with 1.2 km, ozone in a tent 25 ± 15 km (coefficients: see OZONE), ground
// albedo 0.3, Cornette-Shanks phase g = 0.8.
//
// The ground is not a mesh: each pixel intersects the exact sphere (stable formulas, km relative to the Earth centre),
// so the horizon is right at 22 km as well as at 400 000 km. The proxy meshes only decide which pixels run the shaders.
// Radiance scale of the mission: the Sun gives an irradiance E = 3.2, a white Lambert surface facing it reads 3.2/π ≈ 1.
import * as THREE from 'three';
import { EARTH_RADIUS } from './mission-model.js';

const RG = EARTH_RADIUS, RT = EARTH_RADIUS + 100;
const RAYLEIGH = [5.802e-3, 13.558e-3, 33.1e-3], H_RAYLEIGH = 8;
const MIE_SCATTERING = 3.996e-3, MIE_EXTINCTION = 4.40e-3, H_MIE = 1.2, MIE_G = .8;
// Ozone: the same cross-section table Hillaire's (0.650, 1.881, 0.085)e-3 /km come from (Bruneton 2017, IUP Bremen
// O3 spectra at 233 K, 300 DU in a 15 km equivalent layer), read for the sRGB channels instead of at 680/550/440 nm:
// red at 640 nm (the centroid of the sRGB red response; 1.43e-3), green and blue averaged over 500-590 and 430-490 nm.
// The Chappuis band peaks near 600 nm: sampled at 680 nm red is under-absorbed ~2x and the limb seen from orbit turns
// violet (photographs show cyan-blue). The full red-band average (2.03e-3) overshoots the other way and tints the
// twilight sky green: an artefact of rendering with three wavelengths, here balanced between the two.
const OZONE = [1.43e-3, 1.75e-3, .23e-3];
const GROUND_ALBEDO = .3;
const SUN_E = 3.2;
const SUN_RADIUS = .004652; // angular radius of the Sun (rad): the terminator and the planet shadow have this softness
const MOON_FULL = 2.5e-6, NIGHT_EXPOSURE = 3e4; // full-Moon / solar irradiance; night exposure (licence, see update)
// Top of the atmosphere seen by the TOA Sun: 5800 K blackbody against the D65 white of sRGB, normalised to green
// (CIE 1931; the camera is white balanced for daylight, so clouds read near white, very slightly warm).
const SUN_COLOR = [1, .985, .955];
const PROXY_EARTH = RG + 2;   // covers the true sphere despite the flat facets of a 256x128 sphere (max sag ~1 km)
const PROXY_SHELL = RT + 16;  // the airglow layer reaches ~110 km; flat-facet margin on top
const T_SIZE = [256, 64], M_SIZE = 32, E_SIZE = 128, V_SIZE = [192, 256];
const R_TOP = RT + 10; // the airglow layer reaches ~108 km

const g = x => { const s = String(x); return /[.e]/.test(s) ? s : s + '.'; };
const v3 = a => `vec3(${a.map(g).join(',')})`;

// ---------------------------------------------------------------------------------------------------------------
// Shared GLSL: medium, phase functions, LUT parameterisations, the ray march.
const ATMOSPHERE = /* glsl */`
#define A_PI 3.14159265359
const float A_RG = ${g(RG)}, A_RT = ${g(RT)}, A_HTOP = ${g(Math.sqrt(RT * RT - RG * RG))};
const vec3 A_RAY = ${v3(RAYLEIGH)}, A_OZO = ${v3(OZONE)};
const float A_MIE_S = ${g(MIE_SCATTERING)}, A_MIE_E = ${g(MIE_EXTINCTION)}, A_HR = ${g(H_RAYLEIGH)}, A_HM = ${g(H_MIE)}, A_G = ${g(MIE_G)};
const float A_SUN = ${g(SUN_RADIUS)};
const vec2 A_TSIZE = vec2(${g(T_SIZE[0])}, ${g(T_SIZE[1])});
const float A_MSIZE = ${g(M_SIZE)};
uniform sampler2D uTransLUT, uMultiLUT;

// Scattering and extinction coefficients at altitude h (km).
void aMedium(float h, out vec3 scatR, out float scatM, out vec3 ext) {
  h = max(h, 0.);
  float dR = exp(-h / A_HR), dM = exp(-h / A_HM), dO = max(0., 1. - abs(h - 25.) / 15.);
  scatR = A_RAY * dR; scatM = A_MIE_S * dM; ext = A_RAY * dR + vec3(A_MIE_E * dM) + A_OZO * dO;
}
vec3 aExtinction(float h) { vec3 r, e; float m; aMedium(h, r, m, e); return e; }
float aRayleighPhase(float c) { return 3. / (16. * A_PI) * (1. + c * c); }
// Cornette-Shanks: Henyey-Greenstein with the (1 + cos²) term of the Mie solution, g = 0.8 for continental aerosols.
float aMiePhase(float c) {
  float g2 = A_G * A_G;
  return 3. / (8. * A_PI) * (1. - g2) / (2. + g2) * (1. + c * c) / pow(max(1. + g2 - 2. * A_G * c, 1e-4), 1.5);
}
// Ray o + t d (d unit) against a sphere centred at the origin; stable even 400 000 km away (closest-approach form).
vec2 aSphere(vec3 o, vec3 d, float R) {
  float b = dot(o, d); vec3 c = o - b * d; float lc = length(c);
  float h2 = (R - lc) * (R + lc);
  if (h2 < 0.) return vec2(-1., -1.);
  float h = sqrt(h2); return vec2(-b - h, -b + h);
}
float aDistTop(float r, float mu) { return max(0., -r * mu + sqrt(max((A_RT - r) * (A_RT + r) + r * r * mu * mu, 0.))); }
// Transmittance LUT, Bruneton/Hillaire parameterisation (more texels near the ground and the horizon).
vec2 aTransUv(float r, float mu) {
  float rho = sqrt(max((r - A_RG) * (r + A_RG), 0.)), d = aDistTop(r, mu), dMin = A_RT - r, dMax = rho + A_HTOP;
  vec2 x = clamp(vec2((d - dMin) / max(dMax - dMin, 1e-4), rho / A_HTOP), 0., 1.);
  return x * (1. - 1. / A_TSIZE) + .5 / A_TSIZE;
}
vec3 aTransmittance(float r, float mu) { return textureLod(uTransLUT, aTransUv(min(r, A_RT), mu), 0.).rgb; }
// Fraction of the solar disc above the horizon of a point at radius r (planet shadow, soft over the Sun's diameter).
float aSunVisible(float r, float muS) {
  float s = A_RG / max(r, A_RG), muH = -sqrt(max(1. - s * s, 0.));
  return smoothstep(-A_SUN, A_SUN, (muS - muH) / max(s, 1e-3));
}
vec2 aMultiUv(float r, float muS) {
  vec2 x = clamp(vec2(muS * .5 + .5, (r - A_RG) / (A_RT - A_RG)), 0., 1.);
  return x * (1. - 1. / A_MSIZE) + .5 / A_MSIZE;
}
// Sample placement: squared spacing towards the point of lowest altitude on the segment (the closest approach to the
// centre, clamped to it): there the air is densest. It is the ground end for rays that hit the Earth, the tangent
// point for the limb, the camera for a camera inside looking up.
float aWarp(float u, float a, float t0, float tc, float t1) {
  if (u <= a) { float k = (a - u) / max(a, 1e-6); return tc - (tc - t0) * k * k; }
  float k = (u - a) / max(1. - a, 1e-6); return tc + (t1 - tc) * k * k;
}
// Analytic integral of a constant source over a step with extinction (Hillaire's energy-conserving form).
vec3 aStep(vec3 ext, float dt, vec3 tr) { vec3 x = ext * dt; return dt * mix(1. - .5 * x, (1. - tr) / max(x, vec3(1e-6)), step(vec3(1e-3), x)); }
// Fraction of the pixel covered by the ground sphere: the limb is antialiased analytically and the Earth and the sky
// shell agree on every pixel (the shell skips any pixel the Earth touches; the Earth shades the sky part of its edge).
float aCover(vec3 o, vec3 d) {
  float b = dot(o, d), lc = length(o - b * d), pix = length(dFdx(d)) + length(dFdy(d)) + 1e-9;
  return b < 0. ? clamp(.5 - (lc - A_RG) / (.7 * pix * -b), 0., 1.) : 0.;
}
// In-scattered radiance along o + t d, t in [t0, t1], for a unit solar irradiance; trans = transmittance of the segment.
vec3 aIntegrate(vec3 o, vec3 d, float t0, float t1, vec3 sunDir, float n, out vec3 trans) {
  trans = vec3(1.);
  if (t1 <= t0) return vec3(0.);
  vec3 s = o + t0 * d; float len = t1 - t0;
  float tc = clamp(-dot(s, d), 0., len), a = tc / len;
  float cosT = dot(d, sunDir), pR = aRayleighPhase(cosT), pM = aMiePhase(cosT);
  vec3 L = vec3(0.); float tp = 0.;
  for (int i = 0; i < 64; i++) {
    if (float(i) >= n) break;
    float tn = aWarp((float(i) + 1.) / n, a, 0., tc, len), t = aWarp((float(i) + .5) / n, a, 0., tc, len), dt = tn - tp; tp = tn;
    vec3 p = s + t * d; float r = length(p), muS = dot(p, sunDir) / r;
    vec3 sR, ext; float sM; aMedium(r - A_RG, sR, sM, ext);
    vec3 sun = aTransmittance(r, muS) * aSunVisible(r, muS);
    vec3 ms = textureLod(uMultiLUT, aMultiUv(r, muS), 0.).rgb;
    vec3 S = (sR * pR + sM * pM) * sun + (sR + sM) * ms, tr = exp(-ext * dt);
    L += trans * S * aStep(ext, dt, tr); trans *= tr;
  }
  return L;
}
`;

// Night airglow, two layers seen edge-on above the night limb in ISS photographs: the OH Meinel and sodium emission
// (orange-yellow, ~87 km, ~10 km thick) under the thinner O(1S) 557.7 nm green line (~97 km, ~5 km). Seen from above
// they are ~45x fainter than at the limb and disappear.
// Its true radiance is ~1e-7 of daylight: like the city lights it is drawn at the exposure a photographer uses at night
// (uNightGain, artistic licence, see createEarthRenderer).
const AIRGLOW = /* glsl */`
const float AG_R = ${g(RG + 92)}, AG_S = 4.3, AG_S2 = 2., AG_LO = ${g(RG + 87)}, AG_HI = ${g(RG + 97)};
const vec3 AG_OH = vec3(1., .74, .2) * 2.9e-5, AG_OI = vec3(.4, 1., .3) * 4e-5;   // ISS night frames: a thin band, not a glow
vec3 aAirglow(vec3 o, vec3 d, float tMax, vec3 sunDir) {
  float b = dot(o, d); vec3 c = o - b * d; float p = length(c), tc = -b, rOut = AG_R + 17., rIn = AG_R - 17.;
  if (p > rOut) return vec3(0.);
  float sOut = sqrt((rOut - p) * (rOut + p)), sIn = p < rIn ? sqrt((rIn - p) * (rIn + p)) : 0.;
  vec3 sum = vec3(0.);
  for (int k = 0; k < 2; k++) {
    float sg = k == 0 ? -1. : 1., lo = max(tc + sg * (k == 0 ? sOut : sIn), 0.), hi = min(tc + sg * (k == 0 ? sIn : sOut), tMax);
    if (hi <= lo) continue;
    float dt = (hi - lo) / 8.;
    for (int i = 0; i < 8; i++) {
      vec3 p = o + (lo + (float(i) + .5) * dt) * d; float r = length(p), za = (r - AG_LO) / AG_S, zb = (r - AG_HI) / AG_S2;
      sum += (AG_OH * exp(-.5 * za * za) + AG_OI * exp(-.5 * zb * zb)) * (1. - smoothstep(-.3, -.12, dot(p, sunDir) / r)) * dt; // shadowed layer only (below ~-10°)
    }
  }
  return sum;
}
`;

// Sky-view LUT (Hillaire 2020 §5.3), generalised to a camera outside the atmosphere and extended below the horizon:
// for the camera's altitude and the Sun's elevation, the light scattered towards the camera and the transmittance
// along every view direction, up to the top of the atmosphere or to the ground. Rows: nadir angle, packed
// quadratically towards the horizon on both sides of it (the bright limb, the haze over the far ground); columns:
// azimuth from the Sun, 0..π (the problem is symmetric about the Sun's vertical plane). Left half: in-scattered
// radiance (mission scale, airglow included); right half: transmittance. One small table per frame replaces a ray
// march per pixel; since the ground is an exact sphere, the end of every view ray is known and no depth slices are
// needed, the same table gives the aerial perspective of the ground.
const VIEW = /* glsl */`
const float V_W = ${g(V_SIZE[0])}, V_H = ${g(V_SIZE[1])};
uniform sampler2D uViewLUT;
uniform vec3 uViewUp, uViewSunH, uViewSunP;
// Directions are measured by their angle from the NADIR: far from the Earth every ray that matters is within a degree
// of it, where angles near π lose all precision (D3D11 only guarantees ~1e-3 absolute accuracy for sin and cos).
uniform vec2 uViewAngles; // nadir angle of the horizon, nadir angle of the top of the atmosphere (π when inside)
float aNadir(vec3 d) { return atan(length(cross(d, uViewUp)), -dot(d, uViewUp)); }
void aView(vec3 d, bool ground, out vec3 L, out vec3 T) {
  float eh = uViewAngles.x, e = aNadir(d);
  float px = dot(d, uViewSunH), py = abs(dot(d, uViewSunP)), phi = px * px + py * py < 1e-14 ? 0. : atan(py, px);
  // Sky rows: packed towards the horizon; from outside the atmosphere towards its top as well (smoothstep, inverted in
  // closed form), where the airglow lines lie.
  float y = clamp((e - eh) / max(uViewAngles.y - eh, 1e-9), 0., 1.), xs = uViewAngles.y < 3.14 ? .5 - sin(asin(1. - 2. * y) / 3.) : sqrt(y);
  float v = ground ? clamp(.5 + .5 * sqrt(clamp(1. - e / eh, 0., 1.)), .5 + .5 / V_H, 1. - .5 / V_H) : clamp(.5 - .5 * xs, .5 / V_H, .5 - .5 / V_H);
  float u = (phi / A_PI * (V_W - 1.) + .5) / (2. * V_W);
  L = textureLod(uViewLUT, vec2(u, v), 0.).rgb; T = textureLod(uViewLUT, vec2(u + .5, v), 0.).rgb;
}
`;
const VIEW_LUT = /* glsl */`${ATMOSPHERE}${AIRGLOW}
uniform float uR, uMuS, uNadirH, uNadirTop, uSunE, uNightGain;
uniform vec3 uSunColor;
const float V_W = ${g(V_SIZE[0])}, V_H = ${g(V_SIZE[1])};
void main() {
  bool isT = gl_FragCoord.x > V_W;
  float phi = (floor(gl_FragCoord.x) - (isT ? V_W : 0.)) / (V_W - 1.) * A_PI, v = gl_FragCoord.y / V_H;
  bool ground = v > .5; float x = ground ? 2. * v - 1. : 1. - 2. * v;
  float e = ground ? uNadirH * (1. - x * x) : uNadirH + (uNadirTop - uNadirH) * (uNadirTop < 3.14 ? x * x * (3. - 2. * x) : x * x), e2 = e * e;
  // sin and cos of the nadir angle: Taylor series for small angles (exact to 1e-9 below 0.1 rad)
  vec2 sc = e < .1 ? vec2(e * (1. - e2 / 6. * (1. - e2 / 20.)), 1. - e2 / 2. * (1. - e2 / 12.)) : vec2(sin(e), cos(e));
  vec3 d = vec3(sc.x * cos(phi), -sc.y, sc.x * sin(phi)), o = vec3(0., uR, 0.);
  vec3 sun = vec3(sqrt(max(1. - uMuS * uMuS, 0.)), uMuS, 0.);
  vec2 top = aSphere(o, d, A_RT), gr = aSphere(o, d, A_RG);
  // Ground rows end on the ground (the grazing first row, where rounding may miss the sphere, at the tangent point).
  float t0 = max(top.x, 0.), t1 = ground ? (gr.x > 0. ? gr.x : max(-dot(o, d), 0.)) : top.y;
  if (isT) {
    vec3 tau = vec3(0.);
    if (t1 > t0) {
      vec3 s = o + t0 * d; float len = t1 - t0, tc = clamp(-dot(s, d), 0., len), a = tc / len, tp = 0.;
      for (int i = 0; i < 32; i++) {
        float tn = aWarp((float(i) + 1.) / 32., a, 0., tc, len), t = aWarp((float(i) + .5) / 32., a, 0., tc, len);
        tau += aExtinction(length(s + t * d) - A_RG) * (tn - tp); tp = tn;
      }
    }
    gl_FragColor = vec4(exp(-tau), 1.);
  } else {
    vec3 T, L = aIntegrate(o, d, t0, t1, sun, clamp(floor(8. + (t1 - t0) / 50.), 12., 32.), T) * uSunE * uSunColor;
    L += aAirglow(o, d, ground ? t1 : 1e9, sun) * uNightGain;
    gl_FragColor = vec4(min(L, vec3(6e4)), 1.);
  }
}`;

const QUAD_VERTEX = 'void main(){gl_Position=vec4(position.xy,0.,1.);}';
const WORLD_VERTEX = 'varying vec3 vWorld;void main(){vec4 w=modelMatrix*vec4(position,1.);vWorld=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}';
// Explorer cameras span millimetres to thousands of km; match the terrain's logarithmic depth.
const WORLD_LOG_VERTEX = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.); vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}`;
const withLogDepth = source => '#include <logdepthbuf_pars_fragment>\n' + source.replace('void main() {', 'void main() {\n  #include <logdepthbuf_fragment>\n');

// --- LUT passes (run once at startup) ---------------------------------------------------------------------------
const TRANSMITTANCE_LUT = /* glsl */`${ATMOSPHERE}
void main() {
  vec2 x = (gl_FragCoord.xy - .5) / (A_TSIZE - 1.);
  float rho = A_HTOP * x.y, r = sqrt(rho * rho + A_RG * A_RG), dMin = A_RT - r, dMax = rho + A_HTOP, d = dMin + x.x * (dMax - dMin);
  float mu = d <= 0. ? 1. : clamp((A_HTOP * A_HTOP - rho * rho - d * d) / (2. * r * d), -1., 1.);
  vec3 o = vec3(0., r, 0.), dir = vec3(sqrt(max(1. - mu * mu, 0.)), mu, 0.);
  float len = aDistTop(r, mu), tc = clamp(-dot(o, dir), 0., len), a = tc / max(len, 1e-6), tp = 0.;
  vec3 tau = vec3(0.);
  for (int i = 0; i < 48; i++) {
    float tn = aWarp((float(i) + 1.) / 48., a, 0., tc, len), t = aWarp((float(i) + .5) / 48., a, 0., tc, len);
    tau += aExtinction(length(o + t * dir) - A_RG) * (tn - tp); tp = tn;
  }
  gl_FragColor = vec4(exp(-tau), 1.);
}`;

// Hillaire 2020 section 5.5: second-order luminance with an isotropic phase over 64 directions, then the geometric
// series of higher orders Psi_ms = L2 / (1 - f_ms). Includes light reflected by a Lambertian ground (albedo 0.3).
const MULTISCATTER_LUT = /* glsl */`${ATMOSPHERE}
void main() {
  vec2 x = (gl_FragCoord.xy - .5) / (A_MSIZE - 1.);
  float muS = x.x * 2. - 1., r = clamp(A_RG + x.y * (A_RT - A_RG), A_RG + .01, A_RT - .01);
  vec3 o = vec3(0., r, 0.), sun = vec3(sqrt(max(1. - muS * muS, 0.)), muS, 0.), L2 = vec3(0.), F = vec3(0.);
  for (int i = 0; i < 8; i++) for (int j = 0; j < 8; j++) {
    float th = 2. * A_PI * (float(i) + .5) / 8., ph = acos(1. - 2. * (float(j) + .5) / 8.);
    vec3 d = vec3(cos(th) * sin(ph), cos(ph), sin(th) * sin(ph));
    vec2 gr = aSphere(o, d, A_RG); bool ground = gr.x > 0.;
    float len = ground ? gr.x : aSphere(o, d, A_RT).y, tc = clamp(-dot(o, d), 0., len), a = tc / max(len, 1e-6), tp = 0.;
    vec3 T = vec3(1.);
    for (int k = 0; k < 20; k++) {
      float tn = aWarp((float(k) + 1.) / 20., a, 0., tc, len), t = aWarp((float(k) + .5) / 20., a, 0., tc, len), dt = tn - tp; tp = tn;
      vec3 p = o + t * d; float rp = length(p), mp = dot(p, sun) / rp;
      vec3 sR, ext; float sM; aMedium(rp - A_RG, sR, sM, ext);
      vec3 sc = sR + sM, tr = exp(-ext * dt), st = aStep(ext, dt, tr);
      L2 += T * sc * aTransmittance(rp, mp) * aSunVisible(rp, mp) / (4. * A_PI) * st;
      F += T * sc * st; T *= tr;
    }
    if (ground) { vec3 p = o + gr.x * d, n = normalize(p); float mp = dot(n, sun); L2 += T * aTransmittance(A_RG, mp) * max(mp, 0.) * ${g(GROUND_ALBEDO)} / A_PI; }
  }
  L2 /= 64.; F /= 64.;
  gl_FragColor = vec4(L2 / max(1. - F, vec3(1e-3)), 1.);
}`;

// Irradiance a horizontal surface at sea level gets from the whole sky (single + multiple scattering), unit Sun.
// Cosine-weighted directions: E = π · mean(L). Ambient light of the ground and of the clouds, and of the CPU helper.
const IRRADIANCE_LUT = /* glsl */`${ATMOSPHERE}
void main() {
  float muS = (gl_FragCoord.x - .5) / ${g(E_SIZE - 1)} * 2. - 1.;
  vec3 o = vec3(0., A_RG + .01, 0.), sun = vec3(sqrt(max(1. - muS * muS, 0.)), muS, 0.), E = vec3(0.), T;
  for (int i = 0; i < 8; i++) for (int j = 0; j < 8; j++) {
    float u = (float(i) + .5) / 8., ph = 2. * A_PI * (float(j) + .5) / 8., s = sqrt(u);
    vec3 d = vec3(s * cos(ph), sqrt(1. - u), s * sin(ph));
    E += aIntegrate(o, d, 0., aSphere(o, d, A_RT).y, sun, 16., T);
  }
  gl_FragColor = vec4(E * A_PI / 64., 1.);
}`;

// Tileable 3D noise, generated on the GPU (64³): R fbm (cloud wisps), G "Perlin-Worley" cells (cumulus popcorn, city
// blocks), B and A low-frequency fbm used to warp the domain so the structures twist like real cloud fields.
const NOISE_SLICE = /* glsl */`
uniform float uZ;
uvec3 pcg3d(uvec3 v) { v = v * 1664525u + 1013904223u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; v ^= v >> 16u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; return v; }
vec3 hash(ivec3 c, int period, int seed) { uvec3 u = uvec3(c - period * ivec3(floor(vec3(c) / float(period)))) + uvec3(uint(seed) * 7919u, uint(seed) * 104729u, uint(seed) * 1299709u); return vec3(pcg3d(u)) / 4294967295.; }
float valueNoise(vec3 p, int period, int seed) {
  ivec3 i = ivec3(floor(p)); vec3 f = fract(p), w = f * f * (3. - 2. * f);
  float a = hash(i, period, seed).x, b = hash(i + ivec3(1, 0, 0), period, seed).x, c = hash(i + ivec3(0, 1, 0), period, seed).x, d = hash(i + ivec3(1, 1, 0), period, seed).x;
  float e = hash(i + ivec3(0, 0, 1), period, seed).x, f1 = hash(i + ivec3(1, 0, 1), period, seed).x, g1 = hash(i + ivec3(0, 1, 1), period, seed).x, h = hash(i + ivec3(1, 1, 1), period, seed).x;
  return mix(mix(mix(a, b, w.x), mix(c, d, w.x), w.y), mix(mix(e, f1, w.x), mix(g1, h, w.x), w.y), w.z);
}
float fbm(vec3 p, int base, int seed, int octaves) {
  float s = 0., a = .5, t = 0.; int per = base;
  for (int o = 0; o < 6; o++) { if (o >= octaves) break; s += a * valueNoise(p * float(per), per, seed + o); t += a; a *= .5; per *= 2; }
  return clamp((s / t - .5) * 2.1 + .5, 0., 1.);
}
float worley(vec3 p, int cells, int seed) {
  vec3 q = p * float(cells); ivec3 i = ivec3(floor(q)); vec3 f = fract(q); float m = 9.;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
    ivec3 n = ivec3(x, y, z); vec3 r = vec3(n) + hash(i + n, cells, seed) - f; m = min(m, dot(r, r));
  }
  return sqrt(m);
}
void main() {
  vec3 p = vec3((gl_FragCoord.xy) / 64., uZ);
  float cells = clamp(1. - worley(p, 8, 41) * 1.15, 0., 1.), fine = fbm(p, 8, 61, 3);
  gl_FragColor = vec4(fbm(p, 4, 1, 4), clamp(cells * .75 + fine * .35 - .05, 0., 1.), fbm(p, 2, 21, 3), fbm(p, 2, 37, 3));
}`;

// --- Earth surface ------------------------------------------------------------------------------------------------
const EARTH_FRAGMENT = /* glsl */`${ATMOSPHERE}${VIEW}
uniform vec3 uCentre, uSunDir, uSunColor;
uniform float uKmPerUnit, uSunE, uNightGain, uLandSat;
uniform vec3 uMoonDir, uMoonE;
uniform vec4 uCloud, uDayStyle;
uniform mat3 uToEarth;
uniform sampler2D uDay, uNight, uBrc, uIrrLUT;
#ifdef WATER_MAP
uniform sampler2D uWater;
#endif
#ifdef CLOUD_MAP
uniform sampler2D uClouds;
#endif
uniform highp sampler3D uNoise;
varying vec3 vWorld;

// Deep open ocean, water-leaving reflectance ρw = π·Rrs (oligotrophic water, Rrs ≈ 0.008 / 0.0025 / 0.0003 sr⁻¹ at
// 443 / 555 / 670 nm; Morel & Maritorena 2001), in linear sRGB. The day map paints the sea ~5x too bright and flat.
const vec3 OCEAN = vec3(.0035, .0095, .030);
// uDayStyle (set by setMaps' dayStyle): xyz the day map's own deep-ocean colour (linear), w its bright-land gain.
// Cox & Munk (1954): mean square slope 0.003 + 0.00512 W; W ≈ 7 m/s gives 0.039 → GGX α ≈ 0.2. Water F0 = 0.02.
const float OCEAN_ALPHA = .2, WATER_F0 = .02;
const float CLOUD_TOP = 4., CLOUD_SHADOW_H = 2.5, CLOUD_RELIEF = 2.2, RELIEF_KM = 6.;
const float IRR_SCALE = ${g(1 - 1 / E_SIZE)}, IRR_OFFSET = ${g(.5 / E_SIZE)};
// High-pressure sodium (~2100 K) and the whiter LED / metal-halide cores of large cities, linear sRGB.
const vec3 SODIUM = vec3(1., .43, .08), WHITE_LIGHT = vec3(1., .84, .62);

float coverage(float raw) { return clamp((raw - .07) / .83, 0., 1.); }
// Blue Marble colours back to reflectance. The map is stretched for display: its Sahara (linear .83/.67/.50) is ~2x
// brighter and less red than MODIS surface reflectance (~.45/.33/.21), while dark forests (.025/.053/.010) are close to
// the measured .03/.06/.025. Bright warm land is darkened and its saturation restored; snow and ice (bright, grey) keep
// their high albedo (~.75). uDayStyle.w scales the bright end, uLandSat restores its saturation (per map, DAY_STYLES).
vec3 landAlbedo(vec3 t) {
  float l = dot(t, vec3(.2126, .7152, .0722)), k = smoothstep(.05, .6, l);
  float ice = smoothstep(.45, .65, l) * (1. - smoothstep(.06, .16, max(t.r, max(t.g, t.b)) - min(t.r, min(t.g, t.b))));
  vec3 a = max(l + (t - l) * mix(1., uLandSat, smoothstep(.15, .5, l)), 0.) * mix(1.1, uDayStyle.w, k);
  return mix(a, t * 1.05, ice);
}

// Sub-texel cloud structure. The map gives the cloud FRACTION of each ~10 km texel; a threshold on warped noise
// distributes that fraction into shapes without changing the mean (no polka dots: thick decks stay whole, thin
// fractions break into cumulus cells). k1/k2 fade it in only where pixels are finer than the structures (no aliasing).
// Edges sharpen only where the ~2 km cells themselves are resolved (k2): until then a pixel covers many small clouds
// and shows their mean fraction, a soft veil whose density the 8 km wisps modulate (k1); up close the same fraction
// becomes separate cumulus, clustered by the wisps. Never isolated hard-edged "islands", never polka dots.
// uCloud = (weight of the 8 km wisps, weight of the 1.4 km cells, sharpest edge width, -).
// Two 3D fetches: the wisps (R) and, from the same texel, two slow fields (B, A) that warp where the cells are read.
float cloudNoise(vec3 pe, float k1, float k2, out vec4 w) {
  w = textureLod(uNoise, pe / 61., 0.);
  float n2 = k2 > 0. ? textureLod(uNoise, pe / 17.4 + (w.zwz - .5) * 1.6, 0.).y : .5;
  return .5 + k1 * (w.x - .5) * uCloud.x + k2 * (n2 - .5) * uCloud.y;
}
// Coverage-preserving threshold: at s = .5 and wd = .5 it returns c0 unchanged.
float cloudCover(float c0, float s, float wd) { return clamp((c0 + s - 1. + wd) / (2. * wd), 0., 1.); }
// Water under one directional light: GGX glint (Cox-Munk roughness, F0 = 0.02, height-correlated Smith) plus the light
// that enters the water and comes back out (Lambertian water-leaving reflectance, after Fresnel transmission).
vec3 oceanLight(vec3 N, vec3 V, vec3 L, vec3 E, vec3 sea) {
  vec3 h = L + V, H = h * inversesqrt(max(dot(h, h), 1e-12));
  float NoL = max(dot(N, L), 0.), NoV = max(dot(N, V), 1e-3), NoH = max(dot(N, H), 0.), VoH = max(dot(V, H), 0.);
  float a2 = OCEAN_ALPHA * OCEAN_ALPHA, dd = NoH * NoH * (a2 - 1.) + 1., D = a2 / (A_PI * dd * dd);
  float vis = .5 / max(NoL * sqrt(NoV * NoV * (1. - a2) + a2) + NoV * sqrt(NoL * NoL * (1. - a2) + a2), 1e-5);
  float F = WATER_F0 + (1. - WATER_F0) * pow(max(1. - VoH, 0.), 5.);
  return E * NoL * (sea / A_PI * (1. - F) + D * vis * F);
}
vec2 lonLat(vec3 n) { vec2 q = vec2(n.x, -n.z); if (dot(q, q) < 1e-12) q.x = 1e-6; return vec2(atan(q.y, q.x), asin(clamp(n.y, -1., 1.))); }
vec2 lonLatUv(vec2 ll) { return vec2(.5 + ll.x / (2. * A_PI), .5 + ll.y / A_PI); }

void main() {
  vec3 o = (cameraPosition - uCentre) * uKmPerUnit, d = normalize(vWorld - cameraPosition);
  float b = dot(o, d); vec3 cp = o - b * d; float lc = length(cp), h2 = (A_RG - lc) * (A_RG + lc), hh = sqrt(max(h2, 0.));
  float tHit = max(-b - hh, 0.), cover = aCover(o, d);
  vec3 P = cp - d * hh, N = normalize(P); // the hit point; the closest approach when the ray misses (keeps derivatives sane)
  vec3 dPx = dFdx(P), dPy = dFdy(P);
  vec3 Ne = uToEarth * N; vec2 ll = lonLat(Ne), uv = lonLatUv(ll);
  // Derivatives without the seam of atan at the antimeridian (else a line of the smallest mip appears there).
  vec2 dx = dFdx(uv), dy = dFdy(uv); float ub = fract(uv.x + .5), dxb = dFdx(ub), dyb = dFdy(ub);
  if (abs(dxb) < abs(dx.x)) dx.x = dxb; if (abs(dyb) < abs(dy.x)) dy.x = dyb;
  float fp = max(max(length(dPx), length(dPy)), 1e-4); // pixel footprint on the ground, km
  // Cloud field before any discard: its screen derivatives give the fine relief of the cloud tops.
  float k1 = smoothstep(1.5, 4., 8. / fp), k2 = smoothstep(1.5, 4., 2.2 / fp), tex; vec4 nw = vec4(.5);
  vec3 Pe = Ne * A_RG;
  vec4 brc = textureGrad(uBrc, uv, dx, dy);
#ifdef CLOUD_MAP
  float c0 = coverage(textureGrad(uClouds, uv, dx, dy).r), s = .5; tex = .5;
#else
  float c0 = coverage(brc.b), s = .5; tex = .5;
#endif
  if (k1 > 0.) { s = cloudNoise(Pe, k1, k2, nw); tex = nw.x; }
  float wd = max(mix(.5, uCloud.z, k2), 1.5 * fwidth(s)); // sharp only once the cells are resolved, never below a pixel
  // Below ~25 km the 8 km texels of the global cloud map read as blocks: that layer gives way (the pad and the sea
  // scenes have their own cumulus) and returns as the camera climbs.
  float c = cloudCover(c0, s, wd) * smoothstep(4., 25., length(o) - A_RG), dcx = dFdx(c), dcy = dFdy(c);
  if (cover <= 0.) discard;

  vec3 V = -d, L = uSunDir; float muS = dot(N, L);
  vec3 east = vec3(-sin(ll.x), 0., -cos(ll.x)) * uToEarth, north = vec3(-sin(ll.y) * cos(ll.x), cos(ll.y), sin(ll.y) * sin(ll.x)) * uToEarth;
  // Relief and cloud thickness gradients by central differences (at least one texel, at most the pixel footprint).
  // Gradients are low-frequency: forward differences on the isotropic mip of the pixel footprint (two cheap fetches
  // instead of four anisotropic ones).
  vec2 ts = vec2(textureSize(uBrc, 0)), off = max(1. / ts, abs(dx) + abs(dy));
  float lod = max(log2(max(off.x * ts.x, off.y * ts.y)), 0.);
  vec4 b0 = textureLod(uBrc, uv, lod);
  vec4 bE = textureLod(uBrc, uv + vec2(off.x, 0.), lod), bN = textureLod(uBrc, uv + vec2(0., off.y), lod);
  vec2 km = vec2(2. * A_PI * A_RG * max(cos(ll.y), .02) * off.x, A_PI * A_RG * off.y);
  vec2 gH = vec2(bE.r - b0.r, bN.r - b0.r) / km * RELIEF_KM;
  vec3 Nb = normalize(N - gH.x * east - gH.y * north);
#ifdef CLOUD_MAP
  float cl0 = coverage(textureLod(uClouds, uv, lod).r);
  vec2 gC = vec2(coverage(textureLod(uClouds, uv + vec2(off.x, 0.), lod).r) - cl0, coverage(textureLod(uClouds, uv + vec2(0., off.y), lod).r) - cl0) / km;
#else
  vec2 gC = vec2(coverage(bE.b) - coverage(b0.b), coverage(bN.b) - coverage(b0.b)) / km;
#endif
  // Cloud tops: thicker is higher. Fine relief from the screen-space gradient of the detailed field (Mikkelsen 2010).
  vec3 r1 = cross(dPy, N), r2 = cross(N, dPx); float det = dot(dPx, r1);
  vec3 gS = (dcx * r1 + dcy * r2) / (sign(det) * max(abs(det), 1e-10));
  vec3 Nc = normalize(N - CLOUD_RELIEF * mix(gC.x * east + gC.y * north, gS, k1 * .8));

  // Sunlight reaching the ground and the cloud tops: transmittance of the slant path (orange, then red, at the
  // terminator) and the fraction of the solar disc above the horizon.
  vec3 Esun = uSunE * uSunColor;
  vec3 Tg = aTransmittance(A_RG, muS) * smoothstep(-A_SUN, A_SUN, muS);
  vec3 Tc = aTransmittance(A_RG + CLOUD_TOP, muS) * aSunVisible(A_RG + CLOUD_TOP, muS);
  vec3 Esky = textureLod(uIrrLUT, vec2(clamp(muS * .5 + .5, 0., 1.) * IRR_SCALE + IRR_OFFSET, .5), 0.).rgb * Esun;
  // Cloud shadow: the cloud field sampled where the ray from the ground to the Sun crosses it (only in daylight).
  float cs = 0.;
  if (muS > -.02) {
    vec3 Le = uToEarth * L, Ns = normalize(Ne + (Le - Ne * dot(Ne, Le)) * (CLOUD_SHADOW_H / A_RG) / max(muS, .07));
    // Only the ~2 km cells are read again there (one fetch); the slow wisps and warp of the pixel serve unchanged.
    float sS = s;
    if (k2 > 0.) sS = .5 + k1 * (nw.x - .5) * uCloud.x + k2 * (textureLod(uNoise, Ns * A_RG / 17.4 + (nw.zwz - .5) * 1.6, 0.).y - .5) * uCloud.y;
    vec2 uvs = lonLatUv(lonLat(Ns));
#ifdef CLOUD_MAP
    float rawS = textureLod(uClouds, uvs, lod).r;
#else
    float rawS = textureLod(uBrc, uvs, lod).b;
#endif
    cs = cloudCover(coverage(rawS), sS, wd);
  }
  vec3 sunG = Esun * Tg * (1. - .82 * cs);
  // Moonlight, seen at the night exposure (uMoonE, see update): moonlit clouds and sea, as in ISS night photographs.
  vec3 M = uMoonDir, moonG = vec3(0.), moonC = vec3(0.); float muM = dot(N, M);
  if (uMoonE.g > 0. && muM > -.05) {
    moonG = uMoonE * aTransmittance(A_RG, muM) * smoothstep(-.005, .005, muM);
    moonC = uMoonE * aTransmittance(A_RG + CLOUD_TOP, muM) * aSunVisible(A_RG + CLOUD_TOP, muM);
  }

  // Ground: land (calibrated map albedo; sea ice too) or ocean (dark water-leaving albedo, glint, Fresnel sky).
  vec3 day = textureGrad(uDay, uv, dx, dy).rgb;
#ifdef WATER_MAP
  float land = max(1. - smoothstep(.25, .75, textureGrad(uWater, uv, dx, dy).r), smoothstep(.12, .3, dot(day, vec3(.3, .5, .2))));
#else
  float land = max(smoothstep(.25, .75, brc.g), smoothstep(.12, .3, dot(day, vec3(.3, .5, .2))));
#endif
  vec3 landRad = landAlbedo(day) / A_PI * (sunG * max(dot(Nb, L), 0.) + moonG * max(dot(Nb, M), 0.) + Esky);
  float Fv = WATER_F0 + (1. - WATER_F0) * pow(max(1. - dot(N, V), 0.), 5.);
  vec3 sea = OCEAN * clamp(day / max(uDayStyle.xyz, vec3(.002)), .7, 2.5); // shallow seas brighter, as in the map
  vec3 oceanRad = oceanLight(N, V, L, sunG, sea) + oceanLight(N, V, M, moonG, sea) + Esky / A_PI * (sea * (1. - Fv) + 1.3 * Fv);
  vec3 ground = mix(oceanRad, landRad, land);

  // City lights: the Black Marble radiance above its dark-blue background, sodium orange with whiter cores. Lights are
  // point-like sources: magnified ~10 km texels must not turn into soft discs, so the radiance is contrast-sharpened
  // around its texel peaks, then concentrated into clusters (5 km) and points (1.2 km) where pixels resolve them, the
  // mean kept. Dimmed and diffused by clouds, switched on after dusk.
  float on = (1. - smoothstep(-.1, .06, muS)) * uNightGain;
  vec3 city = vec3(0.), cityGlow = vec3(0.);
  if (on > 0.) {
    vec3 nt = textureGrad(uNight, uv, dx, dy).rgb, nb = textureGrad(uNight, uv, dx * 10., dy * 10.).rgb;
    float e = max(dot(nt, vec3(.6, .4, 0.)) - .006, 0.), eb = max(dot(nb, vec3(.6, .4, 0.)) - .006, 0.);
    float sharp = smoothstep(.5, 3., 10. / fp); e = mix(e, e * e * 2.2, sharp);
    float kA = smoothstep(1.5, 4., 5. / fp), kB = smoothstep(1.5, 4., 1.2 / fp);
    float nA = kA > 0. ? textureLod(uNoise, Pe / 41., 0.).y : .5, nB = kB > 0. ? textureLod(uNoise, Pe / 9.7, 0.).y : .5;
    float sL = .5 + kA * (nA - .5) * .9 + kB * (nB - .5) * 1.1, aL = clamp(e * .55, .025, .35);
    float wL = max(mix(.5, .06, max(kA, kB)), .5 * fp / mix(5., 1.2, kB)); // edge no sharper than a pixel
    float lit = clamp((sL - (1. - aL) + wL) / (2. * wL), 0., 1.);
    city = mix(SODIUM, WHITE_LIGHT, smoothstep(.25, .9, e)) * e * lit / aL * 1.25 * on;
    cityGlow = mix(SODIUM, WHITE_LIGHT, .25) * eb * .5 * on;
  }

  // Cloud radiance: bright Lambertian top lit through the transmittance at 4 km (clouds stay lit ~2° past the ground
  // terminator), sky light, a soft forward-scattering lobe for thin cloud seen against a low Sun, moonlight.
  float cosF = -dot(L, V), hg = .64 / pow(max(1.36 - 1.2 * cosF, 1e-3), 1.5);
  float albC = .82 * mix(1., .86 + .28 * tex, k1);
  vec3 cloudRad = albC / A_PI * (Esun * Tc * max(dot(Nc, L), 0.) * (1. + .35 * (1. - c0) * max(hg - 1., 0.)) + moonC * max(dot(Nc, M), 0.) + Esky);
  vec3 surf = mix(ground + city, cloudRad + cityGlow, c);

  // Aerial perspective from the view LUT: the air between the camera and the ground (blue haze, horizon whitening,
  // night darkness, airglow seen edge-on). A limb pixel only partly on the ground gets its sky part here too.
  vec3 T, Lin; aView(d, true, Lin, T);
  vec3 col = surf * T + Lin;
  if (cover < 1.) { vec3 Ls, Ts; aView(d, false, Ls, Ts); col = mix(Ls, col, cover); }
  if (any(isnan(col))) col = vec3(0.);
  gl_FragColor = vec4(min(col, vec3(6e4)), 1.);
}`;

// --- Sky shell: the atmosphere seen against space (rays that miss the ground) ---------------------------------------
// Two draws over the same shell: first the background is MULTIPLIED by the exact chromatic transmittance of the ray
// (the Sun and the Moon redden and dim through the limb), then the in-scattered light is ADDED. A single
// premultiplied blend (ONE, ONE_MINUS_SRC_ALPHA) could only apply a grey mean transmittance.
const SHELL_FRAGMENT = /* glsl */`${ATMOSPHERE}${VIEW}
uniform vec3 uCentre;
uniform float uKmPerUnit;
varying vec3 vWorld;
void main() {
  vec3 o = (cameraPosition - uCentre) * uKmPerUnit, d = normalize(vWorld - cameraPosition);
  if (aCover(o, d) > 0.) discard;             // the Earth shader draws these pixels, aerial perspective included
  vec3 L, T; aView(d, false, L, T);
#ifdef TRANSMIT
  gl_FragColor = vec4(T, 1.);
#else
  gl_FragColor = vec4(L, 1.);
#endif
}`;

// --- Sky dome of the ground scenes (local frame: +Y up, ground plane y = 0, camera at altitude) ---------------------
const DOME_FRAGMENT = /* glsl */`${ATMOSPHERE}${VIEW}
uniform vec3 uSunDir, uSunColor, uGroundColor;
uniform float uSunE;
varying vec3 vWorld;
void main() {
  vec3 d = normalize(vWorld - cameraPosition), L, T;
  bool ground = aNadir(d) < uViewAngles.x;
  aView(d, ground, L, T);
  // Far sea or land below the horizon (only a sliver shows past the scene's own ground): Lambert under the Sun.
  if (ground) L += T * uGroundColor / A_PI * aTransmittance(A_RG, uSunDir.y) * max(uSunDir.y, 0.) * uSunE * uSunColor;
  gl_FragColor = vec4(L, 1.);
}`;

// ---------------------------------------------------------------------------------------------------------------
// CPU side: the same atmosphere, in double precision, for light colours and fog.
function extinctionAt(h) {
  h = Math.max(h, 0); const dR = Math.exp(-h / H_RAYLEIGH), dM = Math.exp(-h / H_MIE), dO = Math.max(0, 1 - Math.abs(h - 25) / 15);
  return [0, 1, 2].map(i => RAYLEIGH[i] * dR + MIE_EXTINCTION * dM + OZONE[i] * dO);
}
const warp = (u, a, t0, tc, t1) => { if (u <= a) { const k = (a - u) / Math.max(a, 1e-9); return tc - (tc - t0) * k * k; } const k = (u - a) / Math.max(1 - a, 1e-9); return tc + (t1 - tc) * k * k; };
// Optical depth from radius r along cos-zenith mu to the top of the atmosphere (the ray must not hit the ground).
function opticalDepth(r, mu, n = 64) {
  const c2 = r * r * (1 - mu * mu); let t0 = 0, t1;
  if (r > RT) { if (mu >= 0 || c2 >= RT * RT) return [0, 0, 0]; const h = Math.sqrt(RT * RT - c2); t0 = -r * mu - h; t1 = -r * mu + h; }
  else t1 = -r * mu + Math.sqrt(Math.max(0, RT * RT - c2));
  const tc = Math.min(Math.max(-r * mu, t0), t1), a = (tc - t0) / Math.max(t1 - t0, 1e-9), tau = [0, 0, 0]; let tp = t0;
  for (let i = 0; i < n; i++) {
    const tn = warp((i + 1) / n, a, t0, tc, t1), t = warp((i + .5) / n, a, t0, tc, t1);
    const e = extinctionAt(Math.sqrt(r * r + t * t + 2 * r * mu * t) - RG); for (let k = 0; k < 3; k++) tau[k] += e[k] * (tn - tp); tp = tn;
  }
  return tau;
}
const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
// Transmittance of sunlight to a point at radius r with the Sun at cos-zenith mu, including the planet's shadow.
function sunTrans(r, mu, n = 48) {
  const s = RG / Math.max(r, RG), muH = -Math.sqrt(Math.max(0, 1 - s * s)), vis = smooth(-SUN_RADIUS, SUN_RADIUS, (mu - muH) / Math.max(s, 1e-3));
  if (vis <= 0) return [0, 0, 0];
  return opticalDepth(r, Math.max(mu, muH + 1e-5), n).map(x => Math.exp(-x) * vis);
}

// ---------------------------------------------------------------------------------------------------------------
const quadScene = new THREE.Scene(), quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); quad.frustumCulled = false; quadScene.add(quad);
function runPass(renderer, target, material, layer = 0) {
  quad.material = material; renderer.setRenderTarget(target, layer); renderer.render(quadScene, quadCamera);
}
const lutTarget = (w, h, type) => new THREE.WebGLRenderTarget(w, h, { type, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
const passMaterial = (fragmentShader, uniforms = {}) => new THREE.ShaderMaterial({ vertexShader: QUAD_VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending });

// Precompute the LUTs (transmittance 256x64, multiple scattering 32x32, sky irradiance 128x1) and the 3D noise.
// The multiple-scattering and irradiance tables are also read back once for the CPU helpers.
function buildTables(renderer) {
  const previous = renderer.getRenderTarget(), half = THREE.HalfFloatType;
  const trans = lutTarget(T_SIZE[0], T_SIZE[1], half), multi = lutTarget(M_SIZE, M_SIZE, half), irr = lutTarget(E_SIZE, 1, half);
  const luts = { uTransLUT: { value: trans.texture }, uMultiLUT: { value: multi.texture } };
  const mats = [passMaterial(TRANSMITTANCE_LUT, luts), passMaterial(MULTISCATTER_LUT, luts), passMaterial(IRRADIANCE_LUT, luts), passMaterial(NOISE_SLICE, { uZ: { value: 0 } })];
  runPass(renderer, trans, mats[0]); runPass(renderer, multi, mats[1]); runPass(renderer, irr, mats[2]);
  const noise = new THREE.WebGL3DRenderTarget(64, 64, 64, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false });
  noise.texture.wrapS = noise.texture.wrapT = noise.texture.wrapR = THREE.RepeatWrapping;
  for (let z = 0; z < 64; z++) { mats[3].uniforms.uZ.value = (z + .5) / 64; runPass(renderer, noise, mats[3], z); }
  // CPU copies (float targets are readable in WebGL2 with EXT_color_buffer_float; without it the helpers skip the
  // multiple-scattering part and use an analytic sky term).
  let msData = null, irrData = null;
  if (renderer.extensions.has('EXT_color_buffer_float')) {
    const readback = (w, h, material) => { const t = lutTarget(w, h, THREE.FloatType), data = new Float32Array(w * h * 4); runPass(renderer, t, material); renderer.readRenderTargetPixels(t, 0, 0, w, h, data); t.dispose(); return data; };
    try { msData = readback(M_SIZE, M_SIZE, mats[1]); irrData = readback(E_SIZE, 1, mats[2]); } catch { msData = irrData = null; }
  }
  renderer.setRenderTarget(previous);
  mats.forEach(m => m.dispose());
  return { trans, multi, irr, noise, msData, irrData, dispose() { trans.dispose(); multi.dispose(); irr.dispose(); noise.dispose(); } };
}
const tableCache = new WeakMap();
// How each day map relates to reflectance: its deep-ocean colour (linear; the shader keeps only the map's relative
// variation of the sea, e.g. shallow banks), the gain of its bright land and the saturation that land needs.
// '4k': earth-day.jpg: flat bright sea sRGB (30, 59, 115), deserts ~2x too bright and too pale.
// 'bmng': earth-day-8k.jpg (Blue Marble Next Generation): dark sea with bathymetry, deserts near reflectance.
const DAY_STYLES = { '4k': { sea: [.0129, .0437, .171], gain: .62, sat: 1.35 }, bmng: { sea: [.0003, .0018, .006], gain: .78, sat: 1 } };

// The per-frame sky-view LUT of one camera: renders it for the camera position (km, relative to the Earth centre) and
// the Sun direction, and fills the uniforms the shaders use to look it up.
function makeView(renderer, U) {
  const target = lutTarget(2 * V_SIZE[0], V_SIZE[1], THREE.HalfFloatType);
  const uniforms = { uTransLUT: U.uTransLUT, uMultiLUT: U.uMultiLUT, uSunE: U.uSunE, uSunColor: U.uSunColor, uNightGain: U.uNightGain,
    uR: { value: RG }, uMuS: { value: 0 }, uNadirH: { value: Math.PI / 2 }, uNadirTop: { value: Math.PI } };
  const material = passMaterial(VIEW_LUT, uniforms);
  const lookup = { uViewLUT: { value: target.texture }, uViewUp: { value: new THREE.Vector3(0, 1, 0) }, uViewSunH: { value: new THREE.Vector3(1, 0, 0) },
    uViewSunP: { value: new THREE.Vector3(0, 0, 1) }, uViewAngles: { value: new THREE.Vector2(Math.PI / 2, Math.PI) } };
  const up = new THREE.Vector3(), sunH = new THREE.Vector3();
  let key = [];
  function render(camKm, sunDir, force = false) {
    const r = Math.max(camKm.length(), RG + .001); up.copy(camKm).divideScalar(r);
    const muS = THREE.MathUtils.clamp(up.dot(sunDir), -1, 1);
    sunH.copy(sunDir).addScaledVector(up, -muS); // Sun at the zenith or nadir: any horizontal axis will do
    if (sunH.lengthSq() < 1e-12) { sunH.set(1, 0, 0).cross(up); if (sunH.lengthSq() < 1e-6) sunH.set(0, 0, 1).cross(up); }
    sunH.normalize();
    const nadirH = Math.asin(Math.min(RG / r, 1)), nadirTop = r > R_TOP ? Math.asin(R_TOP / r) : Math.PI;
    uniforms.uR.value = r; uniforms.uMuS.value = muS; uniforms.uNadirH.value = nadirH; uniforms.uNadirTop.value = nadirTop;
    lookup.uViewUp.value.copy(up); lookup.uViewSunH.value.copy(sunH); lookup.uViewSunP.value.crossVectors(up, sunH); lookup.uViewAngles.value.set(nadirH, nadirTop);
    // The table depends only on the camera radius and the Sun's elevation (and the light settings): redraw it only
    // when they change measurably (in orbit every ~25 frames, on the ground once).
    const h = r - RG, next = [r, muS, U.uSunE.value, U.uNightGain.value, U.uSunColor.value.r, U.uSunColor.value.g, U.uSunColor.value.b];
    const same = !force && key.length && Math.abs(r - key[0]) < (h < 120 ? .02 + h * 2e-4 : r * 2e-5) && Math.abs(muS - key[1]) < 4e-4 && next.slice(2).every((x, i) => x === key[i + 2]);
    if (same) return; key = next;
    const previous = renderer.getRenderTarget(); runPass(renderer, target, material); renderer.setRenderTarget(previous);
  }
  return { lookup, render, target, dispose() { target.dispose(); material.dispose(); } };
}

/**
 * createEarthRenderer(renderer, { day, night, brc, clouds?, water?, dayStyle?, nightGain?, sunColor?, sunIrradiance?, anisotropy? })
 *   day, night: sRGB textures (equirectangular, Greenwich at u = .5); brc: linear, R relief, G land mask, B clouds;
 *   clouds: optional single-channel cloud map (e.g. earth-clouds-8k.jpg, linear) replacing brc.b.
 *   nightGain: exposure of the night side (city lights, airglow). 1 = an astronaut's night exposure. LICENCE: the
 *     real night/day radiance ratio is ~1e-5 to 1e-7; at a single daylight exposure the night side would be black.
 *   anisotropy: texture anisotropy applied to the maps (default 8; 16 costs ~10% more at grazing angles).
 *   water: optional land/water mask (earth-water-8k.png, linear, 255 = water) replacing brc.g.
 *   dayStyle: '4k' (earth-day.jpg, default) or 'bmng' (earth-day-8k.jpg): how the day map relates to reflectance.
 *   physicalNight: remove the mission's 30000x night-exposure licence; city/airglow radiance shares daylight units.
 *   logarithmicDepthBuffer: match a logarithmic-depth renderer (default false preserves the mission shaders).
 * Returns { earth, atmosphere, update(camera, centreWorld, sunDirWorld, kmPerUnit, moonDirWorld?), skyDome(opts),
 *   sunTransmittance(altKm, cosZenith, target?), hazeColor(altKm, sunDirLocal, viewDirLocal?, target?),
 *   skyIrradiance(cosZenith, target?), extinction(altKm), setMaps(maps), uniforms, dispose() }
 *   (plus view and tables: internals, for debugging).
 */
export function createEarthRenderer(renderer, { day, night, brc, clouds = null, water = null, dayStyle = '4k', nightGain = 1, sunColor = SUN_COLOR, sunIrradiance = SUN_E, anisotropy = 8, physicalNight = false, logarithmicDepthBuffer = false } = {}) {
  let tables = tableCache.get(renderer);
  if (!tables) { tables = buildTables(renderer); tables.users = 0; tableCache.set(renderer, tables); }
  tables.users++;
  const sunColorValue = Array.isArray(sunColor) ? new THREE.Color(...sunColor) : new THREE.Color(sunColor);
  const U = {
    uTransLUT: { value: tables.trans.texture }, uMultiLUT: { value: tables.multi.texture }, uIrrLUT: { value: tables.irr.texture }, uNoise: { value: tables.noise.texture },
    uCentre: { value: new THREE.Vector3() }, uKmPerUnit: { value: 1000 }, uSunDir: { value: new THREE.Vector3(1, 0, 0) }, uSunColor: { value: sunColorValue },
    uSunE: { value: sunIrradiance }, uNightGain: { value: nightGain / (physicalNight ? NIGHT_EXPOSURE : 1) }, uLandSat: { value: 1 }, uToEarth: { value: new THREE.Matrix3() },
    uCloud: { value: new THREE.Vector4(.6, 1.1, .17, 0) }, uMoonDir: { value: new THREE.Vector3(0, -1, 0) }, uMoonE: { value: new THREE.Color(0, 0, 0) },
    uDay: { value: null }, uNight: { value: null }, uBrc: { value: null }, uClouds: { value: null }, uWater: { value: null }, uDayStyle: { value: new THREE.Vector4() },
  };
  const view = makeView(renderer, U); Object.assign(U, view.lookup);
  const worldVertex = logarithmicDepthBuffer ? WORLD_LOG_VERTEX : WORLD_VERTEX;
  const fragment = source => logarithmicDepthBuffer ? withLogDepth(source) : source;
  // At sub-pixel footprints det can be exactly zero: sign(0) would still divide by zero before bloom.
  const earthFragment = physicalNight || logarithmicDepthBuffer ? EARTH_FRAGMENT.replace('sign(det) * max(abs(det), 1e-10)', '(det < 0. ? -1. : 1.) * max(abs(det), 1e-10)') : EARTH_FRAGMENT;
  const earthMaterial = new THREE.ShaderMaterial({ uniforms: U, vertexShader: worldVertex, fragmentShader: fragment(earthFragment) });
  let style = DAY_STYLES['4k'];
  // Swap maps at any time, e.g. the 8k set once loaded: setMaps({ day, night, clouds, water, dayStyle: 'bmng' }).
  const setMaps = maps => {
    for (const [key, name] of [['day', 'uDay'], ['night', 'uNight'], ['brc', 'uBrc'], ['clouds', 'uClouds'], ['water', 'uWater']]) {
      if (!(key in maps)) continue; const tex = maps[key]; U[name].value = tex;
      // Repeat across the antimeridian (finite differences and the seam-free derivatives step over it).
      // Anisotropy 8: near the horizon, where 16x costs most on integrated GPUs, the haze hides the difference.
      // Only when a parameter changes: needsUpdate re-uploads the whole image, and an 8k map already on the GPU would go
      // up again at the next draw (~0.3 s each on integrated GPUs, a visible freeze).
      const aniso = Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy());
      if (tex && (tex.wrapS !== THREE.RepeatWrapping || tex.anisotropy !== aniso)) { tex.wrapS = THREE.RepeatWrapping; tex.anisotropy = aniso; tex.needsUpdate = tex.image ? true : tex.needsUpdate; }
    }
    if (maps.dayStyle) style = DAY_STYLES[maps.dayStyle] || DAY_STYLES['4k'];
    U.uDayStyle.value.set(...style.sea, style.gain); U.uLandSat.value = style.sat;
    for (const [define, on] of [['CLOUD_MAP', Boolean(U.uClouds.value)], ['WATER_MAP', Boolean(U.uWater.value)]]) {
      if (Boolean(define in earthMaterial.defines) === on) continue;
      if (on) earthMaterial.defines[define] = ''; else delete earthMaterial.defines[define]; earthMaterial.needsUpdate = true;
    }
  };
  setMaps({ day, night, brc, clouds, water, dayStyle });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(PROXY_EARTH, 256, 128), earthMaterial);
  earth.name = 'earth'; earth.castShadow = earth.receiveShadow = false;
  const shellGeometry = new THREE.SphereGeometry(PROXY_SHELL, 128, 64);
  // The shell is drawn by its FAR faces with the depth test on, outside the atmosphere as inside it. Over the ground
  // the Earth's depth is nearer, so those pixels are rejected before shading (early depth test: on integrated GPUs a
  // discard does not skip the work, and front faces cost the whole disc twice). A Moon or a spacecraft in front of the
  // Earth or of the limb is nearer than the far faces and stays uncovered; the Moon, the Sun or stars beyond the limb
  // are filtered by it.
  const shellMaterial = transmit => new THREE.ShaderMaterial({
    uniforms: U, vertexShader: worldVertex, fragmentShader: fragment(SHELL_FRAGMENT), defines: transmit ? { TRANSMIT: '' } : {},
    side: THREE.BackSide, depthTest: true, transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: transmit ? THREE.ZeroFactor : THREE.OneFactor, blendDst: transmit ? THREE.SrcColorFactor : THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  const transmit = new THREE.Mesh(shellGeometry, shellMaterial(true)), inscatter = new THREE.Mesh(shellGeometry, shellMaterial(false));
  // After every other transparent object of the scene (stars, Sun glare, lines behind the limb are filtered).
  transmit.renderOrder = 1000; inscatter.renderOrder = 1001; transmit.frustumCulled = inscatter.frustumCulled = false;
  const atmosphere = new THREE.Group(); atmosphere.name = 'atmosphere'; atmosphere.add(transmit, inscatter);

  const camPos = new THREE.Vector3(), camKm = new THREE.Vector3(), q = new THREE.Quaternion(), m4 = new THREE.Matrix4(), size = new THREE.Vector2();
  // Call every frame before rendering (camera matrices up to date). Redraws the sky-view LUT when the camera's altitude
  // or the Sun's elevation changed, places both meshes at the Earth centre (their parent must have an identity
  // transform, as the mission's world group) and orients the textures with earth's world rotation (set
  // earth.rotation.y to the sidereal angle beforehand). moonDirWorld (optional, unit or not) lights the night side.
  function update(camera, centreWorld, sunDirWorld, kmPerUnit = 1000, moonDirWorld = null) {
    U.uCentre.value.copy(centreWorld); U.uKmPerUnit.value = kmPerUnit; U.uSunDir.value.copy(sunDirWorld).normalize();
    // Moonlight: full-Moon irradiance ~2.5e-6 of sunlight (0.25 lux), lunar phase law of Allen (1976) /
    // Krisciunas & Schaefer (1991), Moon slightly redder than the Sun. LICENCE: shown at the same night exposure as the
    // city lights (NIGHT_EXPOSURE), which makes a full-Moon-lit cloud read ~0.06, as in ISS night photographs.
    if (moonDirWorld) {
      U.uMoonDir.value.copy(moonDirWorld).normalize();
      const a = 180 - THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(U.uMoonDir.value.dot(U.uSunDir.value), -1, 1)));
      // x0.3: ISS night photographs keep moonlit ground dark and the clouds faintly grey (a full licence read as daylight).
      const e = .3 * U.uSunE.value * MOON_FULL * Math.pow(10, -.4 * (.026 * a + 4e-9 * a ** 4)) * NIGHT_EXPOSURE * U.uNightGain.value;
      U.uMoonE.value.setRGB(e, e * .93, e * .84).multiply(U.uSunColor.value);
    } else U.uMoonE.value.setRGB(0, 0, 0);
    camKm.copy(camera.getWorldPosition(camPos)).sub(centreWorld).multiplyScalar(kmPerUnit); const r = camKm.length();
    view.render(camKm, U.uSunDir.value);
    // The Earth proxy reaches ~2 pixels beyond the true limb, so every limb pixel runs the Earth shader (which
    // antialiases it analytically) even 400 000 km away where 2 km is a hundredth of a pixel.
    const pixel = camera.isPerspectiveCamera ? 2 * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, renderer.getDrawingBufferSize(size).y) : 0;
    const margin = Math.max(PROXY_EARTH - RG, 2.5 * pixel * Math.sqrt(Math.max(r * r - RG * RG, 0)));
    earth.position.copy(centreWorld); earth.scale.setScalar((RG + margin) / PROXY_EARTH / kmPerUnit);
    earth.updateMatrixWorld(); earth.getWorldQuaternion(q).invert(); U.uToEarth.value.setFromMatrix4(m4.makeRotationFromQuaternion(q));
    earthMaterial.side = r < (RG + margin) * 1.0002 ? THREE.BackSide : THREE.FrontSide;
    // Inside (or near) the top, the shell grows so its far faces stay well beyond the camera's near plane.
    atmosphere.position.copy(centreWorld); atmosphere.scale.setScalar((r < PROXY_SHELL ? r + 150 : PROXY_SHELL) / PROXY_SHELL / kmPerUnit);
  }

  // Sky dome of the ground scenes (pad, ocean): local frame, +Y up, plane y = 0 at groundKm above sea level, scene
  // units of kmPerUnit km. The sky only, no solar disc: tint the disc with sunTransmittance(altitude, sunDir.y).
  // Returns { material, update(camera, sunDirLocal), dispose() }; call update every frame the dome is visible.
  function skyDome({ kmPerUnit = 1, groundKm = 0, groundColor = [.05, .07, .09] } = {}) {
    const dv = makeView(renderer, U), sun = new THREE.Vector3(0, 1, 0), at = new THREE.Vector3(), cam = new THREE.Vector3();
    const material = new THREE.ShaderMaterial({
      uniforms: { uTransLUT: U.uTransLUT, uMultiLUT: U.uMultiLUT, uSunE: U.uSunE, uSunColor: U.uSunColor, uSunDir: { value: sun }, uGroundColor: { value: new THREE.Color(...groundColor) }, ...dv.lookup },
      vertexShader: worldVertex, fragmentShader: fragment(DOME_FRAGMENT), side: THREE.BackSide, depthWrite: false, fog: false,
    });
    return {
      material,
      update(camera, sunDirLocal) {
        sun.copy(sunDirLocal).normalize(); camera.getWorldPosition(at);
        dv.render(cam.set(0, RG + Math.max(groundKm + at.y * kmPerUnit, .001), 0), sun);
      },
      view: dv, dispose() { dv.dispose(); material.dispose(); },
    };
  }
  // Colour (and strength) of sunlight after the atmosphere at altitudeKm with the Sun at cosZenith, planet shadow
  // included: multiply a light of the mission's solar intensity by it. Works in orbit too (orbital sunset turns a
  // spacecraft orange, then red, then dark). Linear RGB, 1 = unattenuated.
  function sunTransmittance(altitudeKm, cosZenith, target = new THREE.Color()) {
    const t = sunTrans(RG + Math.max(altitudeKm, 0), Math.min(Math.max(cosZenith, -1), 1)); return target.setRGB(t[0], t[1], t[2]);
  }
  const msAt = (r, muS) => {
    const data = tables.msData; if (!data) return [0, 0, 0];
    const x = Math.min(Math.max((muS * .5 + .5) * (M_SIZE - 1), 0), M_SIZE - 1.0001), y = Math.min(Math.max((r - RG) / (RT - RG) * (M_SIZE - 1), 0), M_SIZE - 1.0001);
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, at = (a, b, k) => data[(b * M_SIZE + a) * 4 + k];
    return [0, 1, 2].map(k => (at(i, j, k) * (1 - fx) + at(i + 1, j, k) * fx) * (1 - fy) + (at(i, j + 1, k) * (1 - fx) + at(i + 1, j + 1, k) * fx) * fy);
  };
  // Radiance of the haze at the horizon of a ground scene (or along viewDirLocal): the in-scattered light of the
  // whole path, i.e. the colour distant objects fade to. Linear, on the mission's radiance scale. Pair it with
  // extinction(altitudeKm) (per km) for the fog density: T(d) = exp(-extinction * d).
  function hazeColor(altitudeKm, sunDirLocal, viewDirLocal = null, target = new THREE.Color()) {
    const sun = new THREE.Vector3().copy(sunDirLocal).normalize(), r0 = RG + Math.max(altitudeKm, .001), sum = [0, 0, 0];
    const dirs = viewDirLocal ? [new THREE.Vector3().copy(viewDirLocal).normalize()] : Array.from({ length: 8 }, (_, i) => new THREE.Vector3(Math.cos(i * Math.PI / 4), 0, Math.sin(i * Math.PI / 4)));
    for (const d of dirs) {
      const b = r0 * d.y, c2 = r0 * r0 - b * b, hitsGround = d.y < 0 && c2 < RG * RG;
      const t1 = hitsGround ? -b - Math.sqrt(RG * RG - c2) : -b + Math.sqrt(RT * RT - c2), cosT = d.dot(sun);
      const pR = 3 / (16 * Math.PI) * (1 + cosT * cosT), g2 = MIE_G * MIE_G, pM = 3 / (8 * Math.PI) * (1 - g2) / (2 + g2) * (1 + cosT * cosT) / Math.pow(Math.max(1 + g2 - 2 * MIE_G * cosT, 1e-4), 1.5);
      const tc = Math.min(Math.max(-b, 0), t1), a = tc / t1, T = [1, 1, 1], n = 40; let tp = 0;
      for (let i = 0; i < n; i++) {
        const tn = warp((i + 1) / n, a, 0, tc, t1), t = warp((i + .5) / n, a, 0, tc, t1), dt = tn - tp; tp = tn;
        const p = new THREE.Vector3(0, r0, 0).addScaledVector(d, t), r = p.length(), h = r - RG, muS = p.dot(sun) / r;
        const dR = Math.exp(-Math.max(h, 0) / H_RAYLEIGH), sM = MIE_SCATTERING * Math.exp(-Math.max(h, 0) / H_MIE), ext = extinctionAt(h), st = sunTrans(r, muS, 24), ms = msAt(r, muS);
        for (let k = 0; k < 3; k++) {
          const sR = RAYLEIGH[k] * dR, S = (sR * pR + sM * pM) * st[k] + (sR + sM) * ms[k], x = ext[k] * dt;
          sum[k] += T[k] * S * (x > 1e-3 ? (1 - Math.exp(-x)) / ext[k] : dt); T[k] *= Math.exp(-x);
        }
      }
    }
    const e = U.uSunE.value / dirs.length, c = U.uSunColor.value;
    return target.setRGB(sum[0] * e * c.r, sum[1] * e * c.g, sum[2] * e * c.b);
  }
  // Irradiance on a horizontal surface at sea level from the whole sky (no direct Sun), mission scale: the right
  // intensity and colour for an AmbientLight / hemisphere fill in the pad and ocean scenes.
  function skyIrradiance(cosZenith, target = new THREE.Color()) {
    const data = tables.irrData, e = U.uSunE.value, c = U.uSunColor.value;
    if (!data) { const k = Math.max(0, cosZenith + .1) * .08 * e; return target.setRGB(k * .6 * c.r, k * .8 * c.g, k * c.b); }
    const x = Math.min(Math.max((cosZenith * .5 + .5) * (E_SIZE - 1), 0), E_SIZE - 1.0001), i = Math.floor(x), f = x - i, at = (a, k) => data[a * 4 + k];
    return target.setRGB(...[0, 1, 2].map(k => (at(i, k) * (1 - f) + at(i + 1, k) * f) * e * [c.r, c.g, c.b][k]));
  }
  const extinction = altitudeKm => { const e = extinctionAt(altitudeKm); return (e[0] + e[1] + e[2]) / 3; };
  function dispose() {
    earth.geometry.dispose(); earthMaterial.dispose(); shellGeometry.dispose(); transmit.material.dispose(); inscatter.material.dispose(); view.dispose();
    if (--tables.users <= 0) { tables.dispose(); tableCache.delete(renderer); }
  }
  return { earth, atmosphere, update, skyDome, sunTransmittance, hazeColor, skyIrradiance, extinction, setMaps, uniforms: U, view, tables, dispose };
}
