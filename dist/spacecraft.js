import * as THREE from 'three';

// Apollo-era hardware, built from published dimensions (metres) and shown at true scale in the
// lunar and ocean scenes. Shapes are simplified; proportions, colours and the order of the stages
// follow the Saturn V / CSM / LM of the 1969–1972 missions. Visual only: no number depends on it.
// One scene unit is 1 km, so every model is wrapped in a group scaled by 0.001.

const Y = new THREE.Vector3(0, 1, 0);
const v2 = (x, y) => new THREE.Vector2(x, y);

function noise2(seed) {
  const h = (x, y) => { let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 982451653)) | 0; n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967295; };
  return (x, y, p) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, w = k => ((k % p) + p) % p;
    const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
    const a = h(w(xi), w(yi)), b = h(w(xi + 1), w(yi)), c = h(w(xi), w(yi + 1)), d = h(w(xi + 1), w(yi + 1));
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}


function canvasTexture(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

// Environment for metal: what a spacecraft reflects. Near the Moon: grey regolith below, black sky above.
function environmentScene({ sky = [0, 0, 0], ground = [0.34, 0.33, 0.31], horizon = null, sun = true } = {}) {
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uSky: { value: new THREE.Color(...sky) }, uGround: { value: new THREE.Color(...ground) }, uHorizon: { value: new THREE.Color(...(horizon || ground)) } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: 'uniform vec3 uSky, uGround, uHorizon; varying vec3 vDir; void main(){ float y = vDir.y; vec3 c = y > 0. ? mix(uHorizon, uSky, smoothstep(0., .35, y)) : mix(uHorizon, uGround, smoothstep(0., .12, -y)); gl_FragColor = vec4(c, 1.); }'
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), material));
  // A small bright patch where the Sun would be keeps highlights alive on polished surfaces.
  if (sun) { const patch = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 5.8, 5.4) })); patch.position.set(6, 3, 5); scene.add(patch); }
  return scene;
}
const disposeScene = scene => scene.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
// The shaders makeEnvironment's pass draws with (the surround, the Sun patch, PMREM's background box, its blur and GGX
// filters at the default 256 px cube), compiled ahead in parallel (KHR_parallel_shader_compile): makeEnvironment draws
// at once, and where each new shader's first draw waits for its compile (Windows, ANGLE) that froze the page ~1.4 s.
// The programs live while a material holds them: dispose the handle only after makeEnvironment has run.
export function warmEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer), scene = environmentScene(), flat = new THREE.Scene(), extra = [];
  let ready = Promise.resolve();
  const previous = renderer.getRenderTarget();
  try {
    pmrem._setSize(256); const target = pmrem._allocateTargets(); extra.push(target);
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false })));
    for (const m of [pmrem._blurMaterial, pmrem._ggxMaterial]) if (m) flat.add(new THREE.Mesh(new THREE.BufferGeometry(), m));
    renderer.setRenderTarget(target); // drawn into a half-float target: linear output, no tone mapping
    ready = Promise.all([renderer.compileAsync(scene, new THREE.PerspectiveCamera(90, 1, .1, 100)), renderer.compileAsync(flat, new THREE.OrthographicCamera())]);
  } catch { /* compiled on first use instead */ } finally { renderer.setRenderTarget(previous); }
  return { ready: ready.catch(() => {}), dispose() { disposeScene(scene); flat.traverse(o => o.geometry?.dispose()); extra.forEach(x => x.dispose()); pmrem.dispose(); } };
}
export function makeEnvironment(renderer, options = {}) {
  const scene = environmentScene(options);
  const pmrem = new THREE.PMREMGenerator(renderer), previousClear = renderer.autoClear;
  const previousTarget = renderer.getRenderTarget(), previousFace = renderer.getActiveCubeFace(), previousMip = renderer.getActiveMipmapLevel();
  let target;
  // PMREM must clear each cube face even when the application's compositor disables autoClear.
  try { renderer.autoClear = true; target = pmrem.fromScene(scene, 0.02); }
  finally {
    renderer.autoClear = previousClear; renderer.setRenderTarget(previousTarget, previousFace, previousMip);
    pmrem.dispose(); disposeScene(scene);
  }
  return target;
}

// Crumpled Kapton/Mylar foil computed from the position on the vehicle (metres), not from texture coordinates:
// NASA's mesh stretches its UVs, which drew the creases as streaks and made textured panels stand out as patches.
// Flat facets with straight creases: dominant-plane Voronoi cells (~9 cm at 11 per metre), each tilted at random,
// plus two octaves of fine ridged wrinkles (|n − ½| folds, analytic gradients). The slope tilts the normal along the
// surface; facets under ~3 pixels and wrinkles under ~2 fade out, so the foil does not sparkle from afar.
const FOIL_VARYINGS = 'varying vec3 vFoilPos, vFoilN, vFoilX, vFoilY, vFoilZ;\n';
const FOIL_NOISE = `uniform vec3 uFoil;
uniform vec4 uFoilLook;
vec3 foilHash3(vec3 p) {
  p = fract(p * vec3(.1031, .1030, .0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float foilHash(vec3 p) { return foilHash3(p).x; }
vec3 foilFacetSlope(vec3 x, vec3 n) {
  vec3 an = abs(n);
  bool axisX = an.x >= an.y && an.x >= an.z, axisY = !axisX && an.y >= an.z;
  vec2 p = axisX ? x.yz : (axisY ? x.xz : x.xy);
  float axis = axisX ? 0. : (axisY ? 31. : 67.);
  vec2 cell = floor(p), local = fract(p), nearestCell = cell;
  float nearestDistance = 1e10;
  for (int y = -1; y <= 1; y++) {
    for (int ix = -1; ix <= 1; ix++) {
      vec2 offset = vec2(float(ix), float(y)), candidate = cell + offset;
      vec2 delta = offset + foilHash3(vec3(candidate, axis)).xy - local;
      float distanceSquared = dot(delta, delta);
      if (distanceSquared < nearestDistance) { nearestDistance = distanceSquared; nearestCell = candidate; }
    }
  }
  vec2 slope = foilHash3(vec3(nearestCell, axis) + vec3(19.19, 47.77, 73.73)).xy * 2. - 1.;
  slope *= inversesqrt(max(dot(slope, slope), 1e-8));
  return axisX ? vec3(0., slope) : (axisY ? vec3(slope.x, 0., slope.y) : vec3(slope, 0.));
}
vec4 foilNoise(vec3 x) {
  vec3 i = floor(x), w = fract(x), u = w * w * w * (w * (w * 6. - 15.) + 10.), du = 30. * w * w * (w * (w - 2.) + 1.);
  float a = foilHash(i), b = foilHash(i + vec3(1, 0, 0)), c = foilHash(i + vec3(0, 1, 0)), d = foilHash(i + vec3(1, 1, 0));
  float e = foilHash(i + vec3(0, 0, 1)), f = foilHash(i + vec3(1, 0, 1)), g = foilHash(i + vec3(0, 1, 1)), h = foilHash(i + vec3(1, 1, 1));
  float k1 = b - a, k2 = c - a, k3 = e - a, k4 = a - b - c + d, k5 = a - c - e + g, k6 = a - b - e + f, k7 = -a + b + c - d + e - f - g + h;
  return vec4(a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z,
    du * vec3(k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z, k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x, k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y));
}
`;
const FOIL_APPLY = `{
  float foilPx = length(fwidth(vFoilPos)), foilF = uFoil.y;
  float foilFacetFade = 1. - smoothstep(1. / 5., 1. / 3., foilPx * foilF);
  vec3 foilG = vec3(0.);
  if (uFoilLook.x < .5 && foilFacetFade > 0.) foilG = uFoil.x * foilFacetFade * foilFacetSlope(vFoilPos * foilF, vFoilN);
  // The two wrinkle octaves share a total slope budget of 35% of the facet strength.
  float foilA = uFoil.x * (uFoilLook.x > .5 ? 1. : (.35 / 1.5));
  if (uFoilLook.x < .5) foilF *= uFoil.z;
  for (int i = 0; i < 3; i++) {
    if (i == 2 && uFoilLook.x < .5) break;
    float foilFade = 1. - smoothstep(1. / 4., 1. / 2., foilPx * foilF);
    if (foilFade > 0.) {
      vec4 nd = foilNoise(vFoilPos * foilF + float(i) * 17.31);
      float fold = uFoilLook.x > .5 ? (nd.x - .5) / max(abs(nd.x - .5), .035) : sign(nd.x - .5);
      foilG += foilA * foilFade * fold * nd.yzw;
    }
    foilF *= uFoil.z; foilA *= .5;
  }
  vec3 foilN = vFoilN * inversesqrt(max(dot(vFoilN, vFoilN), 1e-12));
  vec3 foilS = foilG - dot(foilG, foilN) * foilN;
  mat3 foilM = mat3(vFoilX, vFoilY, vFoilZ);
  vec3 foilTilt = normal - faceDirection * foilM * foilS / max(length(foilM * foilN), 1e-6);
  normal = foilTilt * inversesqrt(max(dot(foilTilt, foilTilt), 1e-12));
}
`;
const FOIL_SURFACE = `
  float foilBlack = 0., foilSilver = 0., foilFine = .5;
  if (uFoilLook.x > .5) {
    float foilPxColor = max(length(fwidth(vFoilPos)), 1e-7);
    float foilFineFade = 1. - smoothstep(.2, .6, foilPxColor * 145.);
    foilFine = mix(.5, foilNoise(vFoilPos * 145.).x, foilFineFade);
    float foilMottle = foilNoise(vFoilPos * 4.7).x;
    diffuseColor.rgb *= mix(.72, 1.14, foilMottle);
    // AS11-40-5927: black thermal shielding around the upper descent bays; exposed silver deck.
    if (uFoilLook.x > 1.5) {
      float upperBelt = smoothstep(2.54, 2.56, vFoilPos.y);
      float sideBay = max(step(1.55, vFoilPos.x), step(vFoilPos.z, -1.55));
      foilBlack = max(upperBelt, sideBay * smoothstep(1.72, 1.74, vFoilPos.y));
      foilSilver = step(2.88, vFoilPos.y) * smoothstep(.55, .8, abs(vFoilN.y));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.012, .011, .010), foilBlack);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.48, .47, .44), foilSilver);
    }
  }
`;
const FOIL_ROUGHNESS = `
  if (uFoilLook.x > .5) roughnessFactor = clamp(mix(roughnessFactor + (foilFine - .5) * .28, .76, foilBlack * (1. - foilSilver)), .13, 1.);
`;
const FOIL_METALNESS = `
  if (uFoilLook.x > .5) metalnessFactor = mix(metalnessFactor, .12, foilBlack * (1. - foilSilver));
`;
// strength: slope of the coarsest creases; frequency: creases per metre; lacunarity: frequency step per octave.
function crumple(material, strength, frequency, lacunarity = 2.13, look = 0) {
  material.normalMap = null;
  material.onBeforeCompile = shader => {
    shader.uniforms.uFoil = { value: new THREE.Vector3(strength, frequency, lacunarity) };
    shader.uniforms.uFoilLook = { value: new THREE.Vector4(look, look && material.roughnessMap ? .23 : material.roughness, 0, 0) };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + FOIL_VARYINGS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFoilPos = position; vFoilN = objectNormal; vFoilX = normalMatrix[0]; vFoilY = normalMatrix[1]; vFoilZ = normalMatrix[2];');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + FOIL_VARYINGS + FOIL_NOISE)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FOIL_SURFACE)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + FOIL_ROUGHNESS)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + FOIL_METALNESS)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FOIL_APPLY);
  };
  material.customProgramCacheKey = () => 'foil-4';
  return material;
}

// Aluminium sheets and painted hardware: all distances are object-space metres, independent of UVs.
// The sheet relief uses polynomial height gradients, no neighbour searches or extra noise octaves.
const PANEL_NOISE = `uniform vec4 uPanel, uPanelRelief, uPanelFinish;
uniform vec2 uPanelInk;
float panelHash(vec2 p) {
  vec3 h = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  h += dot(h, h.yzx + 33.33);
  return fract((h.x + h.y) * h.z);
}
float panelNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), w = f * f * (3. - 2. * f);
  return mix(mix(panelHash(i), panelHash(i + vec2(1., 0.)), w.x),
    mix(panelHash(i + vec2(0., 1.)), panelHash(i + vec2(1.)), w.x), w.y);
}
vec2 panelDomeSlope(vec2 delta, float radius, float height) {
  float r2 = max(radius * radius, 1e-10);
  float cap = max(1. - dot(delta, delta) / r2, 0.);
  return (-4. * height / r2) * cap * delta;
}
`;
const PANEL_SURFACE = `
  // Take derivatives before normal-dependent projection; branches contain no derivative operations.
  float panelPx = max(max(length(dFdx(vFoilPos)), length(dFdy(vFoilPos))), 1e-7);
  vec3 panelN = vFoilN * inversesqrt(max(dot(vFoilN, vFoilN), 1e-12));
  vec3 panelAN = abs(panelN);
  bool panelX = panelAN.x >= panelAN.y && panelAN.x >= panelAN.z;
  bool panelY = !panelX && panelAN.y >= panelAN.z;
  vec2 panelUV = panelX ? vFoilPos.yz : (panelY ? vFoilPos.xz : vFoilPos.xy);
  float panelSize = max(uPanel.x, .1), panelPitch = max(uPanel.y, .01);
  vec2 panelCell = floor(panelUV / panelSize), panelLocal = fract(panelUV / panelSize) * panelSize;
  vec2 panelEdge = min(panelLocal, vec2(panelSize) - panelLocal);
  float panelFade = 1. - smoothstep(.15, .4, panelPx / panelSize);
  float panelBoundary = smoothstep(0., max(panelPx * 1.5, 1e-6), min(panelEdge.x, panelEdge.y));
  float panelValue = (panelHash(panelCell + (panelX ? 17. : (panelY ? 43. : 79.))) * 2. - 1.)
    * panelFade * panelBoundary * uPanelRelief.w;
  // One elongated noise octave: broad handling marks with faint, lengthwise streaks.
  float panelStreakFade = 1. - smoothstep(.15, .4, panelPx * 25.);
  float panelStreak = (panelNoise(panelUV * vec2(25., .8)) * 2. - 1.) * panelStreakFade;
  float panelTone = 1. + uPanelFinish.x * panelValue + uPanelFinish.z * panelStreak;
  vec3 panelTint = mix(vec3(.95, .98, 1.03), vec3(1.05, .98, .93), clamp(.5 + .5 * panelStreak, 0., 1.));
  diffuseColor.rgb = clamp(diffuseColor.rgb * max(panelTone, .1)
    * mix(vec3(1.), panelTint, uPanelFinish.w * panelStreakFade), 0., 1.);
  // Apollo LM aluminium heat shields: dark sheet joints and the heads of the fastener rows.
  float panelJoint = 1. - smoothstep(max(uPanelRelief.y * .35, .0001), max(uPanelRelief.y * .35, .0001) + panelPx * 1.2,
    min(panelEdge.x, panelEdge.y));
  vec2 inkCenters = clamp(floor((panelLocal - uPanel.z) / panelPitch + .5) * panelPitch + uPanel.z,
    vec2(uPanel.z), vec2(panelSize - uPanel.z));
  float inkRivet = min(length(vec2(panelEdge.x - uPanel.z, panelLocal.y - inkCenters.y)),
    length(vec2(panelLocal.x - inkCenters.x, panelEdge.y - uPanel.z)));
  float inkDot = 1. - smoothstep(uPanel.w * .65, uPanel.w + panelPx, inkRivet);
  diffuseColor.rgb *= 1. - panelFade * (uPanelInk.x * panelJoint + uPanelInk.y * inkDot);
`;
const PANEL_ROUGHNESS = `
  roughnessFactor = clamp(roughnessFactor + uPanelFinish.y * (panelValue + .3 * panelStreak), .04, 1.);
`;
const PANEL_APPLY = `{
  vec2 panelSlope = vec2(0.);
  if (uPanelRelief.w > .5) {
    float seamWidth = max(uPanelRelief.y, .0002);
    float seamFade = 1. - smoothstep(.4 * seamWidth, seamWidth, panelPx);
    vec2 seamDelta = mix(panelLocal, panelLocal - vec2(panelSize), step(vec2(.5 * panelSize), panelLocal));
    vec2 seamT = clamp(seamDelta / seamWidth, -1., 1.);
    panelSlope = (4. * uPanelRelief.z / seamWidth) * seamT * (1. - seamT * seamT) * seamFade;
    float rivetRadius = max(uPanel.w, .001);
    float rivetFade = 1. - smoothstep(.4 * rivetRadius, rivetRadius, panelPx);
    vec2 rivetCenters = clamp(floor((panelLocal - uPanel.z) / panelPitch + .5) * panelPitch + uPanel.z,
      vec2(uPanel.z), vec2(panelSize - uPanel.z));
    vec2 edgeSign = vec2(1.) - 2. * step(vec2(.5 * panelSize), panelLocal);
    vec2 rowX = vec2((panelEdge.x - uPanel.z) * edgeSign.x, panelLocal.y - rivetCenters.y);
    vec2 rowY = vec2(panelLocal.x - rivetCenters.x, (panelEdge.y - uPanel.z) * edgeSign.y);
    // A corner belongs to both rows; the nearest dome avoids doubling its height.
    vec2 rivetDelta = dot(rowX, rowX) <= dot(rowY, rowY) ? rowX : rowY;
    panelSlope += panelDomeSlope(rivetDelta, rivetRadius, uPanelRelief.x) * rivetFade;
  }
  vec3 panelG = panelX ? vec3(0., panelSlope) : (panelY ? vec3(panelSlope.x, 0., panelSlope.y) : vec3(panelSlope, 0.));
  panelG -= dot(panelG, panelN) * panelN;
  mat3 panelM = mat3(vFoilX, vFoilY, vFoilZ);
  vec3 panelTilt = normal - faceDirection * panelM * panelG / max(length(panelM * panelN), 1e-6);
  normal = panelTilt * inversesqrt(max(dot(panelTilt, panelTilt), 1e-12));
}
`;
// The ascent-stage skin: seams wide enough to read from a few metres, clear panel-to-panel tone changes.
const LM_PANELS = { radius: .006, height: .0012, seamWidth: .004, seamDepth: .002, albedoVariation: .14, roughnessVariation: .1, smudge: .03 };
function rivetPanel(material, opts = {}) {
  const bounded = (key, fallback, lo, hi) => Number.isFinite(opts[key]) ? THREE.MathUtils.clamp(opts[key], lo, hi) : fallback;
  const size = bounded('panelSize', .7, .5, .9), pitch = bounded('pitch', .07, .06, .08);
  const panelled = opts.panelled !== false;
  const inset = bounded('inset', .025, .015, .04), span = size - 2 * inset;
  // Fit complete intervals between both corner rivets; retain 6–8 cm spacing at each end.
  const intervals = THREE.MathUtils.clamp(Math.round(span / pitch), Math.ceil(span / .08), Math.floor(span / .06));
  const surface = new THREE.Vector4(size, span / Math.max(intervals, 1), inset, bounded('radius', .004, .002, .008));
  const relief = new THREE.Vector4(bounded('height', .0007, 0, .002), bounded('seamWidth', .0015, .0005, .005), bounded('seamDepth', .0006, 0, .003), panelled ? 1 : 0);
  const finish = new THREE.Vector4(bounded('albedoVariation', .05, 0, .2), bounded('roughnessVariation', .035, 0, .12), bounded('smudge', .015, 0, .06), bounded('heatTint', 0, 0, 1));
  const ink = new THREE.Vector2(bounded('seamInk', 0, 0, .8), bounded('rivetInk', 0, 0, .5));
  const varyings = panelled ? FOIL_VARYINGS : 'varying vec3 vFoilPos, vFoilN;\n';
  material.normalMap = null;
  material.onBeforeCompile = shader => {
    shader.uniforms.uPanel = { value: surface }; shader.uniforms.uPanelRelief = { value: relief }; shader.uniforms.uPanelFinish = { value: finish };
    shader.uniforms.uPanelInk = { value: ink };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + varyings)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFoilPos = position; vFoilN = objectNormal;' + (panelled ? ' vFoilX = normalMatrix[0]; vFoilY = normalMatrix[1]; vFoilZ = normalMatrix[2];' : ''));
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + varyings + PANEL_NOISE)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + PANEL_SURFACE)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + PANEL_ROUGHNESS);
    if (panelled) shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + PANEL_APPLY);
  };
  material.customProgramCacheKey = () => panelled ? 'rivet-panel-2' : 'rivet-panel-2-finish';
  return material;
}

export function createMaterials(envMap) {
  const std = (o) => new THREE.MeshStandardMaterial({ envMap, envMapIntensity: 1, ...o });
  const quadrants = canvasTexture(256, 64, (g, w, h) => { g.fillStyle = '#f1f0ea'; g.fillRect(0, 0, w, h); g.fillStyle = '#121214'; g.fillRect(0, 0, w / 4, h); g.fillRect(w / 2, 0, w / 4, h); });
  const gores = canvasTexture(512, 64, (g, w, h) => { const n = 24; for (let i = 0; i < n; i++) { g.fillStyle = i % 2 ? '#f3efe6' : '#e2672b'; g.fillRect(i * w / n, 0, w / n + 1, h); } g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(0, h * 0.82, w, h * 0.06); });
  const m = {
    mirror: std({ color: 0xe4e7ea, metalness: 1, roughness: 0.16 }),
    aluminium: rivetPanel(std({ color: 0xc8ccd0, metalness: 0.85, roughness: 0.4 }), { panelled: false }),
    radiator: std({ color: 0xe9ebec, metalness: 0.35, roughness: 0.42 }),
    white: rivetPanel(std({ color: 0xecebe5, metalness: 0, roughness: 0.72 }), { panelled: false, smudge: .012 }),
    black: rivetPanel(std({ color: 0x141416, metalness: 0, roughness: 0.93 }), { panelled: false, smudge: .025 }),
    quadrants: std({ map: quadrants, metalness: 0, roughness: 0.55 }),
    bell: rivetPanel(std({ color: 0x383734, metalness: 0.65, roughness: 0.58, side: THREE.DoubleSide }), { panelled: false, smudge: .025, heatTint: .8 }),
    bellBand: std({ color: 0x8d9095, metalness: 0.9, roughness: 0.3, side: THREE.DoubleSide }),
    gold: crumple(std({ color: 0xd7a042, metalness: 1, roughness: 0.4 }), 0.17, 13),
    amber: crumple(std({ color: 0xa8742a, metalness: 1, roughness: 0.46 }), 0.16, 13),
    silverFoil: crumple(std({ color: 0xc9cacb, metalness: 1, roughness: 0.34 }), 0.18, 13),
    charcoal: rivetPanel(std({ color: 0x292a2b, metalness: 0.35, roughness: 0.65 }), { panelled: false, smudge: .02, heatTint: .3 }),
    greyPanel: rivetPanel(std({ color: 0x8f8f8b, metalness: 0.6, roughness: 0.48 }), LM_PANELS),
    glass: std({ color: 0x0b1216, metalness: 0.3, roughness: 0.04 }),
    heatShield: std({ color: 0x5e412a, metalness: 0.05, roughness: 0.85 }),
    red: std({ color: 0x8e2c20, metalness: 0.1, roughness: 0.6 }),
    chute: new THREE.MeshStandardMaterial({ map: gores, side: THREE.DoubleSide, roughness: 0.92, metalness: 0 }),
    line: new THREE.LineBasicMaterial({ color: 0xdedad0, transparent: true, opacity: 0.55 }),
  };
  // NASA model materials: plain colours become the simulation's own materials (foil, paint, metal);
  // textured ones (skins, flags, decals) are kept, with the same reflections as the rest.
  m.lmSkin = rivetPanel(std({ color: 0xaaa9a4, metalness: 0.65, roughness: 0.48 }), LM_PANELS);
  const plain = { blinn1SG: m.gold, blinn9SG: m.amber, blinn6SG: m.black, blinn2SG: m.charcoal, blinn4SG: m.aluminium, blinn3SG: m.lmSkin, initialShadingGr: m.greyPanel, blinn10SG: m.white, blinn13SG: m.bell, apollohorns_blin: m.bell, apollohorns_bli1: m.charcoal };
  const finish = { blinn14SG: [0.85, 0.24], blinn11SG: [0.4, 0.42] }, kept = new Map();
  // NASA's "UNITED STATES" placard and US flag become the NASA Space Apps Challenge logo and emblem (official artwork,
  // spaceappschallenge.org/brand), on the same rectangles of the same UV layout: a placard and paint on the gold foil.
  // The second map holds roughness (G) and metalness (B): the foil stays metal, the placard and the paint do not.
  const DECALS = { blinn8SG: 'lm-placard', blinn12SG: 'lm-emblem' }, decalMaps = [], loader = new THREE.TextureLoader();
  const decal = (file, srgb) => {
    // The scene may draw only on demand: m.onTextureLoad (set by the caller) asks for a new picture once a decal arrives.
    const tex = loader.load(new URL(`./assets/mission/models/${file}.png`, import.meta.url).href, () => m.onTextureLoad?.());
    tex.flipY = false; tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; tex.anisotropy = 8; decalMaps.push(tex); return tex;
  };
  m.nasa = source => {
    const name = source.name.split('.')[0];
    if (plain[name] && !source.map) return plain[name];
    if (!kept.has(source.uuid)) {
      const c = source.clone(), f = finish[name] || [0.15, 0.6]; c.envMap = m.white.envMap; c.metalness = f[0]; c.roughness = f[1];
      if (DECALS[name]) { c.map = decal(DECALS[name], true); c.metalnessMap = c.roughnessMap = decal(`${DECALS[name]}-rm`); c.metalness = c.roughness = 1; c.color.set(0xffffff); crumple(c, 0.3, 11); }
      kept.set(source.uuid, c);
    }
    return kept.get(source.uuid);
  };
  // LM-only finishes: keep the CSM/Saturn materials and their environment response unchanged.
  // Apollo surface photos: bare/anodized shields, black Inconel/H-film, amber Kapton, dusty aluminium pads.
  // Full cube faces need no CubeCamera/renderer clear state; no artificial reflected studio Sun.
  // At 7 degrees: 3.1 * sin(7 deg) * regolith albedo .12 / PI is ~.014 radiance.
  const cubeImages = [];
  for (let face = 0; face < 6; face++) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
    const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(32, 32);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const u = (x + .5) / 16 - 1, v = (y + .5) / 16 - 1;
      const ny = (face === 2 ? 1 : face === 3 ? -1 : -v) / Math.sqrt(1 + u * u + v * v);
      const ground = 1 - THREE.MathUtils.smoothstep(ny, -.08, .08);
      const color = new THREE.Color().setRGB(.00012 + .016 * ground, .00016 + .014 * ground, .00022 + .011 * ground).convertLinearToSRGB();
      const i = (y * 32 + x) * 4;
      pixels.data[i] = Math.round(color.r * 255); pixels.data[i + 1] = Math.round(color.g * 255); pixels.data[i + 2] = Math.round(color.b * 255); pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0); cubeImages.push(canvas);
  }
  const lmEnvironment = new THREE.CubeTexture(cubeImages); lmEnvironment.colorSpace = THREE.SRGBColorSpace; lmEnvironment.needsUpdate = true;
  const lmPanels = { ...LM_PANELS, panelSize: .58, seamInk: .55, rivetInk: .28, albedoVariation: .18 };
  m.lmPanel = rivetPanel(std({ color: 0x97948a, metalness: .55, roughness: .38 }), lmPanels);
  m.lmPaint = rivetPanel(std({ color: 0x9e9b91, metalness: .22, roughness: .55 }), { ...lmPanels, panelSize: .72 });
  m.lmGold = crumple(std({ color: 0xe0aa45, metalness: .97, roughness: .3 }), .6, 21, 2.23, 1);
  m.lmAmber = crumple(std({ color: 0xad6721, metalness: .96, roughness: .32 }), .62, 23, 2.17, 1);
  m.lmDescentFoil = crumple(std({ color: 0xd9a13b, metalness: .97, roughness: .3 }), .6, 21, 2.23, 2);
  m.lmSilver = crumple(std({ color: 0xbabbb5, metalness: .95, roughness: .3 }), .5, 25, 2.13, 1);
  m.lmBlack = crumple(std({ color: 0x12110f, metalness: .12, roughness: .73 }), .44, 34, 2.13, 1);
  m.lmRCS = rivetPanel(std({ color: 0x151411, metalness: .28, roughness: .67 }), { panelled: false, heatTint: .35 });
  m.lmMetal = rivetPanel(std({ color: 0xacaea8, metalness: .78, roughness: .42 }), { panelled: false });
  m.lmPad = rivetPanel(std({ color: 0x9d9c91, metalness: .62, roughness: .68 }), { panelled: false, smudge: .05 });
  const lmKept = new Map();
  const lmLighting = material => {
    // Regolith ~0.12 albedo: attenuate inherited hemisphere/studio fill, never the direct Sun.
    // Vendor r186 lights_fragment_maps/end expose irradiance separately from direct light.
    material.envMap = lmEnvironment; material.envMapIntensity = 1; material.userData.lmSurface = true;
    const compile = material.onBeforeCompile, key = material.customProgramCacheKey();
    material.onBeforeCompile = shader => {
      compile.call(material, shader);
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_maps>',
        '#include <lights_fragment_maps>\n#if defined( RE_IndirectDiffuse )\nirradiance *= .12;\n#endif');
    };
    material.customProgramCacheKey = () => key + '-lm-bounce-1'; return material;
  };
  for (const [name, material] of Object.entries(m)) if (name.startsWith('lm') && material?.isMaterial && name !== 'lmSkin') lmLighting(material);
  const lmPlain = { blinn1SG: m.lmGold, blinn9SG: m.lmAmber, blinn6SG: m.lmBlack, blinn2SG: m.lmRCS,
    blinn4SG: m.lmMetal, blinn3SG: m.lmPanel, initialShadingGr: m.lmPaint, blinn7SG: m.lmSilver, blinn10SG: m.lmPaint };
  m.lmNasa = (source, mesh) => {
    const name = source.name.split('.')[0], node = mesh.name.replace(/_/g, ' ');
    // NASA model's group13 primitives are the sixteen RCS engine bells, not gold foil.
    if (/^group13\b/.test(node) && name === 'blinn1SG') return m.lmRCS;
    if (/^group31 19\b/.test(node)) return m.lmPad;
    if (/^pCylinder1(?:$|[ .])/.test(node)) return m.lmDescentFoil;
    if (/^pCylinde10(?:$|[ .])/.test(node)) return m.lmSilver;
    if (/^pCylinder9(?:$|[ .])/.test(node)) return m.lmBlack;
    if (name === 'blinn7SG' && /^(group73|group74|pCylinder[67])/.test(node)) return m.lmBlack;
    if (name === 'blinn7SG' && /^(group75|pCylinder8)/.test(node) && mesh.geometry.boundingBox?.max.y < .7) return m.lmAmber;
    if (lmPlain[name] && !source.map) return lmPlain[name];
    if (!lmKept.has(source.uuid)) {
      const c = m.nasa(source).clone();
      if (DECALS[name]) crumple(c, .8, 28, 2.23, 1);
      lmKept.set(source.uuid, lmLighting(c));
    }
    return lmKept.get(source.uuid);
  };
  m.lm = Object.assign(Object.create(m), { gold: m.lmGold, amber: m.lmAmber, silverFoil: m.lmSilver,
    black: m.lmBlack, charcoal: m.lmRCS, greyPanel: m.lmPanel, aluminium: m.lmMetal });
  m.dispose = () => { for (const x of decalMaps) x.dispose(); quadrants.dispose(); gores.dispose(); lmEnvironment.dispose(); for (const x of Object.values(m)) if (x?.isMaterial) x.dispose(); for (const x of [...kept.values(), ...lmKept.values()]) x.dispose(); };
  m.setEnvironment = map => { for (const x of [...Object.values(m), ...kept.values(), ...lmKept.values()]) if (x?.isMeshStandardMaterial && x !== m.chute) x.envMap = x.userData.lmSurface ? lmEnvironment : map; };
  return m;
}

function add(parent, geometry, material, position, rotation) {
  const mesh = new THREE.Mesh(geometry, material); if (position) mesh.position.set(...position); if (rotation) mesh.rotation.set(...rotation);
  mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}
const cyl = (rt, rb, h, s = 40, open = false) => new THREE.CylinderGeometry(rt, rb, h, s, 1, open);
// A stage of a NASA model, with the simulation's materials.
function nasaPart(source, m, lunar = false) {
  const g = new THREE.Group();
  for (const mesh of source.children) {
    const c = new THREE.Mesh(mesh.geometry, lunar ? m.lmNasa(mesh.material, mesh) : m.nasa(mesh.material));
    c.name = mesh.name; c.userData.lmSourceName = mesh.name; c.userData.lmSourceMaterial = mesh.material.name;
    c.castShadow = c.receiveShadow = true; g.add(c);
  }
  return g;
}
// Rocket-engine bell: throat at y = 0, exit at y = −length.
function bellGeometry(throat, exit, length, segments = 40) {
  const pts = []; for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push(v2(throat + (exit - throat) * Math.pow(t, 0.62), -length * t)); }
  return new THREE.LatheGeometry(pts, segments);
}
function strut(parent, a, b, radius, material) {
  const d = b.clone().sub(a), mesh = add(parent, cyl(radius, radius, d.length(), 10), material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5); mesh.quaternion.setFromUnitVectors(Y, d.normalize()); return mesh;
}
// Four-thruster RCS quad facing outward along +x of its own frame.
function rcsQuad(parent, m, position, yaw) {
  const g = new THREE.Group(); g.position.set(...position); g.rotation.y = yaw; parent.add(g);
  add(g, new THREE.BoxGeometry(0.24, 0.5, 0.36), m.greyPanel);
  for (const [dx, dy, dz, rx, rz] of [[0, 0.33, 0, 0, 0], [0, -0.33, 0, Math.PI, 0], [0, 0, 0.26, Math.PI / 2, 0], [0, 0, -0.26, -Math.PI / 2, 0]]) add(g, cyl(0.03, 0.07, 0.16, 12), m.bell, [dx, dy, dz], [rx, 0, rz]);
  return g;
}

// ---- Exhaust and entry plasma ----
// Both are volumes of glowing gas, integrated along every view ray inside a cone-shaped hull (emission and,
// for the sooty F-1 flame, absorption), so they have no hard edges, get brighter where the eye looks through
// more gas, and stay on the scene's radiance scale: 1 is a white surface facing the Sun (sunlight 3.2 / π).
// Only gas that is really bright goes over the bloom threshold (1). Lengths are metres in the model frame.

const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const WIEN = 25924; // c2 / 555 nm, K: brightness ratio of two temperatures at the eye's peak sensitivity (Wien's law)

let lookup = null;
function exhaustTextures() {
  if (lookup) return lookup;
  // Tileable value noise: R, G turbulence (four octaves, two seeds), B finer grain stretched into streaks in the shader.
  const size = 128, nr = noise2(11), ng = noise2(23), nb = noise2(37), data = new Uint8Array(size * size * 4);
  const fbm = (n, x, y, p0, octaves) => { let v = 0, a = 0.5, sum = 0; for (let o = 0; o < octaves; o++) { const p = p0 << o; v += a * n(x / size * p, y / size * p, p); sum += a; a *= 0.5; } return v / sum; };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    data[i] = fbm(nr, x, y, 4, 4) * 255; data[i + 1] = fbm(ng, x, y, 4, 4) * 255; data[i + 2] = fbm(nb, x, y, 16, 2) * 255; data[i + 3] = 255;
  }
  const noise = new THREE.DataTexture(data, size, size, THREE.RGBAFormat); noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
  noise.generateMipmaps = true; noise.minFilter = THREE.LinearMipmapLinearFilter; noise.magFilter = THREE.LinearFilter; noise.needsUpdate = true;
  // Colour of a black body from 800 K to 10 000 K (even steps in 1/T), linear sRGB normalised to luminance 1:
  // Planck's law integrated against the CIE 1931 observer (Wyman, Sloan & Shirley 2013 fit). Soot in a flame,
  // hot char and the heat shield radiate close to grey bodies, so this sets their colour from their temperature.
  const n = 256, ramp = new Uint16Array(n * 4), lobe = (x, m, s1, s2) => { const t = (x - m) / (x < m ? s1 : s2); return Math.exp(-0.5 * t * t); };
  for (let i = 0; i < n; i++) {
    const T = 1e6 / (1250 - 1150 * i / (n - 1));
    let X = 0, Yl = 0, Z = 0;
    for (let l = 380; l <= 780; l += 5) {
      const m = l * 1e-9, B = 1 / (m ** 5 * (Math.exp(0.014388 / (m * T)) - 1));
      X += B * (1.056 * lobe(l, 599.8, 37.9, 31) + 0.362 * lobe(l, 442, 16, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2));
      Yl += B * (0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1));
      Z += B * (1.217 * lobe(l, 437, 11.8, 36) + 0.681 * lobe(l, 459, 26, 13.8));
    }
    const r = Math.max(0, 3.2406 * X - 1.5372 * Yl - 0.4986 * Z), g = Math.max(0, -0.9689 * X + 1.8758 * Yl + 0.0415 * Z), b = Math.max(0, 0.0557 * X - 0.204 * Yl + 1.057 * Z);
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    [r / L, g / L, b / L, 1].forEach((v, k) => { ramp[i * 4 + k] = THREE.DataUtils.toHalfFloat(v); });
  }
  const blackbody = new THREE.DataTexture(ramp, n, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  blackbody.minFilter = blackbody.magFilter = THREE.LinearFilter; blackbody.wrapS = blackbody.wrapT = THREE.ClampToEdgeWrapping; blackbody.needsUpdate = true;
  // One hull for every volume: a unit cylinder the vertex shader stretches into the frustum of the moment.
  const hull = new THREE.CylinderGeometry(1, 1, 1, 32, 1, false);
  return (lookup = { noise, blackbody, hull });
}
// Linear sRGB of a black body at T kelvin, luminance 1 (CPU twin of the shader's ramp(), from the same table).
function blackbodyColor(T, target = new THREE.Color()) {
  const { blackbody } = exhaustTextures(), d = blackbody.image.data, n = blackbody.image.width;
  const x = Math.min(n - 1, Math.max(0, (1250 - 1e6 / T) / 1150 * (n - 1))), i = Math.floor(x), f = x - i, j = Math.min(n - 1, i + 1);
  const at = k => THREE.DataUtils.fromHalfFloat(d[i * 4 + k]) * (1 - f) + THREE.DataUtils.fromHalfFloat(d[j * 4 + k]) * f;
  return target.setRGB(at(0), at(1), at(2));
}

const VOLUME_VERTEX = /* glsl */`
uniform vec4 uHull; // frustum r = x + y·a for a in [z, w]; a is the distance downstream along −Y
varying vec3 vPos;
void main() {
  float a = mix(uHull.z, uHull.w, .5 - position.y);
  float rad = (uHull.x + uHull.y * a) * 1.012; // 32-gon around the analytic cone
  vPos = vec3(position.x * rad, -a, position.z * rad);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vPos, 1.);
}`;

const VOLUME_FRAGMENT = /* glsl */`
uniform vec3 uCam;          // camera in this frame (metres), computed in double precision on the CPU
uniform float uTime, uInside, uSteps, uStepLen;
uniform vec4 uHull, uOccA, uOccB;
uniform sampler2D uNoise, uRamp;
varying vec3 vPos;

vec3 ramp(float T) { return texture2D(uRamp, vec2(clamp((1250. - 1e6 / max(T, 100.)) / 1150., 0., 1.), .5)).rgb; }
// Temperature of gas whose brightness is b times that of the hottest gas (T0), from Wien's law at 555 nm:
// soot that is ten times dimmer is ~300 K cooler, so the flame reddens exactly where it fades.
float tempOf(float b, float T0) { return 1. / (1. / T0 - log(clamp(b, 1e-6, 4.)) / 25924.); }
float sq(float x) { return x * x; }

// Ray o + t·d against the solid frustum r <= x + y·a, z <= a <= w (a = −y). Returns [t_in, t_out] (empty if in > out).
vec2 frustum(vec3 o, vec3 d, vec4 h) {
  float oa = -o.y, da = -d.y, tn = -1e6, tf = 1e6;
  if (abs(da) > 1e-7) { float t0 = (h.z - oa) / da, t1 = (h.w - oa) / da; tn = min(t0, t1); tf = max(t0, t1); }
  else if (oa < h.z || oa > h.w) return vec2(1., 0.);
  float s = h.x + h.y * oa, ks = h.y * da;
  float A = d.x * d.x + d.z * d.z - ks * ks, B = o.x * d.x + o.z * d.z - s * ks, C = o.x * o.x + o.z * o.z - s * s;
  if (abs(A) < 1e-9) {
    if (abs(B) < 1e-12) return C <= 0. ? vec2(tn, tf) : vec2(1., 0.);
    float t = -C / (2. * B); if (B > 0.) tf = min(tf, t); else tn = max(tn, t); return vec2(tn, tf);
  }
  float disc = B * B - A * C;
  if (disc < 0.) return A > 0. ? vec2(1., 0.) : vec2(tn, tf);
  float q = sqrt(disc), lo = min((-B - q) / A, (-B + q) / A), hi = max((-B - q) / A, (-B + q) / A);
  if (A > 0.) return vec2(max(tn, lo), min(tf, hi));
  // Ray steeper than the wall: the inside is the part on the cone's own nappe (radius >= 0).
  vec2 i1 = vec2(tn, min(tf, lo)), i2 = vec2(max(tn, hi), tf);
  if (i1.y > i1.x && s + ks * .5 * (i1.x + i1.y) >= 0.) return i1;
  if (i2.y > i2.x && s + ks * .5 * (i2.x + i2.y) >= 0.) return i2;
  return vec2(1., 0.);
}
// Solid parts of the vehicle inside the hull stop the ray (they are drawn opaque before the gas).
float occlude(vec3 o, vec3 d, float t0, float t1, vec4 h) {
  if (h.w <= h.z) return t1;
  vec2 s = frustum(o, d, h);
  return s.y > s.x && s.y > t0 ? min(t1, max(s.x, t0)) : t1;
}

vec4 field(vec3 p);
float stepAt(vec3 p);

// Emission and absorption integrated front to back; each step uses the exact solution for a constant
// source over its length. Sample spacing follows the size of the structure where the sample is (fine at the
// nozzles and the gas cap, coarse in the bulb or the far wake), never finer than chord / uSteps.
void march(vec3 o, vec3 d, vec2 seg, float jitter, inout vec3 L, inout float T) {
  if (seg.y <= seg.x) return;
  float minDt = (seg.y - seg.x) / uSteps, t = seg.x;
  for (int i = 0; i < 48; i++) {
    if (t >= seg.y - 1e-5 || T < .004) break;
    float dt = min(max(stepAt(o + d * t), minDt), seg.y - t);
    vec4 s = field(o + d * (t + jitter * dt));
    float tr = exp(-s.a * dt);
    L += T * s.rgb * (s.a > 1e-4 ? (1. - tr) / s.a : dt);
    T *= tr; t += dt;
  }
}

float clipRay(vec3 o, vec3 d, float t0, float t1);

void main() {
  // Front faces from outside; back faces (without depth test) when the camera is inside the hull.
  if (gl_FrontFacing == (uInside > .5)) discard;
  vec3 o = uCam, d = normalize(vPos - uCam);
  vec2 seg = frustum(o, d, uHull);
  float t0 = max(seg.x, 0.), t1 = clipRay(o, d, t0, seg.y);
  t1 = occlude(o, d, t0, t1, uOccA); t1 = occlude(o, d, t0, t1, uOccB);
  if (t1 <= t0 + 1e-4) discard;
  // White-noise jitter of the samples, new every frame: without temporal accumulation it reads as film grain,
  // where a structured pattern (interleaved gradient noise) would show as a fixed texture.
  vec3 q3 = fract(vec3(gl_FragCoord.xy, fract(uTime * 7.31) * 113.) * vec3(.1031, .1030, .0973)); q3 += dot(q3, q3.yzx + 33.33);
  float jitter = fract((q3.x + q3.y) * q3.z);
  vec3 L = vec3(0.); float T = 1.;
  march(o, d, vec2(t0, t1), jitter, L, T);
  gl_FragColor = vec4(min(L, vec3(3e4)), 1. - T); // premultiplied: dst = L + dst·T
}

#ifndef PLASMA
uniform vec4 uCores[5];    // exit centre (x, z), exit radius, ignition weight
uniform int uCoreCount;
uniform vec4 uShape;       // envelope radius at the exit, spread (tan), altitude bulge, bulge length
uniform vec4 uAxial;       // brightness e-folding length, merging length, turbine-film length, flat top (0..1)
uniform vec4 uEmit;        // luminance per metre, T0 (K), turbulence, total exit area (r², weighted)
uniform vec4 uFilm;        // film extinction, core brightness inside the film, film brightness, soot extinction
uniform vec4 uTint;        // rgb tint, w: 1 = band emitter (colour = tint), 0 = soot (colour from temperature)
uniform vec4 uSmoke;       // amount, length (in e-folding lengths), in-scattered luminance, 0
uniform vec4 uHaze;        // luminance per metre, length, spread (tan), streakiness
uniform vec4 uRecirc;      // brightness, length, body radius, sheath thickness
uniform vec4 uGround;      // a of the ground (< 0: none), splash brightness, length of the visible plume, 0
uniform vec2 uCoreGlow;    // share of the brightness in the hot core at the exit, its e-folding length
uniform vec4 uNozzle;      // bell length, throat radius, 0, 1 = draw the gas inside the bell (single engines)
uniform float uStreaks;    // radial streaks of a vacuum plume (0..1)

float stepAt(vec3 p) {
  float ap = max(-p.y, 0.);
  float w = uShape.x + ap * uShape.y + uShape.z * (1. - exp(-ap / uShape.w));
  if (uHaze.x > 0. && length(p.xz) > w) w = max(w, .6 * (uShape.x * .8 + ap * uHaze.z)); // out in the faint, smooth haze
  return max(uStepLen, mix(.3, .6, smoothstep(10., 40., ap)) * w);
}
float clipRay(vec3 o, vec3 d, float t0, float t1) {
  float oa = -o.y, da = -d.y;
  if (uNozzle.w > 0.) {
    // The bell is a thin shell: a ray that reaches it through the exit opening sees the gas inside until it
    // meets the wall; one that reaches it from outside stops there.
    vec2 b = frustum(o, d, vec4(uShape.x * 1.01, (uShape.x - uNozzle.y) / uNozzle.x, -uNozzle.x, 0.));
    if (b.y > b.x && b.y > t0) { float ain = -(o.y + d.y * max(b.x, t0)); t1 = ain > -.03 * uNozzle.x ? min(t1, b.y) : min(t1, max(b.x, t0)); }
  }
  if (uGround.x < 0.) return t1;
  if (oa > uGround.x) return t0;
  return da > 1e-6 ? min(t1, (uGround.x - oa) / da) : t1;
}

vec4 field(vec3 p) {
  float a = -p.y, ap = max(a, 0.), r = length(p.xz), ang = atan(p.z, p.x) * .1591549 + .5;
  vec3 em = vec3(0.); float sig = 0.;
  float w = uShape.x + ap * uShape.y + uShape.z * (1. - exp(-ap / uShape.w));
  // Vacuum plumes flow out in straight rays from the exit; injector and film-cooling non-uniformities show
  // as radial streaks (OMS photographs). Index: azimuth and the ray's angle from the axis.
  float st = .5;
  // Rays, not sheets: the pattern varies with the polar angle as well, so a line of sight averages it.
  if (uStreaks > 0. || uHaze.x > 0.) { vec2 sv = vec2(ang, r / (ap + uShape.x * 2.)); st = textureLod(uNoise, sv * vec2(2., .9), 0.).b * .6 + textureLod(uNoise, sv * vec2(5., 2.1) + .37, 0.).r * .4; }
  if (a < 0. && uNozzle.w > 0.) {
    // Gas inside the bell, seen through the exit: denser and hotter towards the throat.
    float rn = uShape.x + (uShape.x - uNozzle.y) / uNozzle.x * a;
    if (r < rn) em += (uTint.w > .5 ? uTint.rgb : ramp(uEmit.y) * uTint.rgb) * uEmit.x * .22 * min(sq(uShape.x / rn), 4.);
    return vec4(em, 0.);
  }
  // Turbulence boils as it is carried downstream (eddies move too fast to be followed frame to frame).
  float turb = 1.;
  if (uEmit.z > 0.) {
    vec2 nu = vec2(ang * 4., ap / (2.5 * w + 4.));
    // Fixed LOD: the azimuth wraps from 1 to 0 across one half-plane, and derivatives there would pick the coarsest mip.
    float n = textureLod(uNoise, nu + vec2(0., -uTime * .9), 0.).r * .6 + textureLod(uNoise, nu * vec2(2., 2.6) + vec2(.31, -uTime * 2.3), 0.).g * .4;
    turb = max(0., 1. + uEmit.z * (n * 2. - 1.) * 2. * smoothstep(0., 8., ap));
  }
  if (a >= 0.) {
    // Separate exhausts at the nozzles, one envelope downstream.
    float merge = smoothstep(0., uAxial.y, a), flatTop = uAxial.w, cores = 0., film = 0.;
    if (merge < 1.) for (int i = 0; i < 5; i++) {
      if (i >= uCoreCount) break;
      vec4 c = uCores[i]; float wc = c.z + a * uShape.y, dc = length(p.xz - c.xy) / wc;
      cores += c.w * mix(exp(-2.5 * dc * dc), 1. - smoothstep(.65, 1.12, dc), flatTop) * c.z * c.z / (wc * wc);
      film = max(film, c.w * smoothstep(.5, .8, dc) * (1. - smoothstep(1., 1.25, dc)));
    }
    float x = r / w, merged = mix(exp(-2.5 * x * x), 1. - smoothstep(.65, 1.15, x), flatTop) * uEmit.w / (w * w);
    // Density fluctuations show at the plume's edges; the far end fades out (no hull edge in sight).
    float rho = mix(cores, merged, merge) * mix(1., turb, smoothstep(.45, 1.1, x)) * (1. - smoothstep(uGround.z * .6, uGround.z, a));
    // Brightness falls downstream as the gas expands and cools: a hot core just past the exit (the part that
    // saturates in photographs) over a fainter, longer glow.
    // In the high-altitude bulb the gas has expanded far beyond its width at sea level and cooled with it.
    float wn = uShape.x + ap * uShape.y;
    float b = (mix(1., exp(-a / uCoreGlow.y), uCoreGlow.x) * exp(-a / uAxial.x)) * turb * pow(max(wn / w, 0.), 1.2) * mix(1., .55 + .9 * st, uStreaks * smoothstep(0., uShape.x, a));
    if (uAxial.z > 0.) {
      // F-1: the fuel-rich turbine exhaust that cools the nozzle extension shrouds the hot core in dark,
      // sooty gas for a few metres, until it mixes with the air and burns.
      float lit = smoothstep(uAxial.z * .6, uAxial.z * 1.6, a), shell = film * (1. - lit);
      b *= mix(uFilm.y, 1., lit); b = mix(b, uFilm.z, shell); sig += uFilm.x * shell;
    }
    em += (uTint.w > .5 ? uTint.rgb : ramp(tempOf(b, uEmit.y)) * uTint.rgb) * uEmit.x * rho * b;
    sig += uFilm.w * rho;
    if (uSmoke.x > 0.) {
      // Soot that has stopped glowing: absorbs, and scatters daylight (single scattering, isotropic).
      float sm = uSmoke.x * rho * (1. - exp(-a / uAxial.x)) * exp(-a / (uAxial.x * uSmoke.y)) * (.6 + .8 * turb * .5);
      sig += uFilm.w * sm; em += vec3(.86, .74, .6) * uSmoke.z * uFilm.w * sm;
    }
    if (uHaze.x > 0.) {
      // In sunlight: droplets and ice in the expanding exhaust scatter light in a broad, radially streaked fan.
      float wh = uShape.x * .8 + a * uHaze.z, xh = r / wh;
      em += vec3(.94, .95, .97) * uHaze.x * exp(-2. * xh * xh) * sq(uShape.x / wh) * exp(-a / uHaze.y) * mix(1., .45 + 1.1 * st, uHaze.w);
    }
  }
  if (uRecirc.x > 0. && a < 4. * uRecirc.y) {
    // F-1 high up: the plume spreads so far that hot gas flows back up around the base of the stage.
    float up = exp(-abs(a) / uRecirc.y), sh = exp(-sq((r - uRecirc.z - uRecirc.w) / uRecirc.w)), br = uRecirc.x * up * sh * turb;
    em += ramp(tempOf(br, uEmit.y)) * uEmit.x * .05 * br; sig += uFilm.w * .05 * br;
  }
  if (uGround.x >= 0. && uGround.y > 0.) {
    // Exhaust stopped by a surface spreads along it (the lunar ascent engine firing into the descent stage).
    float ds = exp(-sq((a - uGround.x) / .3)) * exp(-r / (.5 + .5 * uGround.x));
    em += ramp(uEmit.y) * uEmit.x * uGround.y * ds;
  }
  return vec4(em, sig);
}
#else
uniform vec4 uCM;          // base radius, shield sphere radius, shield depth, afterbody length
uniform vec4 uPlasma;      // luminance per metre: gas cap, shoulder shear layer, wake, bow-shock envelope
uniform vec4 uPlasma2;     // wake e-folding length, cap T0, shear T0, flicker
uniform vec3 uCapTint, uWakeTint, uEnvTint;
uniform float uEarly;      // 0..1: thin, non-equilibrium shock layer at the start of entry (nitrogen band colours)
const vec3 N2CAP = vec3(1.25, .8, 1.3), N2WAKE = vec3(1.7, .6, 1.75), COOL = vec3(2.2, .55, .7); // pink-violet; cooling ionised gas

float clipRay(vec3 o, vec3 d, float t0, float t1) { return t1; }
float stepAt(vec3 p) { return .15 + .07 * max(-p.y, 0.); } // ~0.15 m through the gas cap, metres down the wake

vec4 field(vec3 p) {
  float a = -p.y, r = length(p.xz), R = uCM.x, hS = uCM.z, ang = atan(p.z, p.x) * .1591549 + .5;
  vec3 em = vec3(0.);
  // Gas cap: air between the detached bow shock (standoff ~0.25 m, Billig's blunt-body fit) and the heat shield,
  // compressed and heated to ~10 000 K; hottest at the stagnation point, cooling towards the shoulder.
  float aShock = -.28 + r * r / 13., aWall = r < R ? r * r / (2. * uCM.y) : hS;
  float layer = smoothstep(aShock - .07, aShock + .07, a) * (1. - smoothstep(aWall - .03, aWall + .06, a)) * (1. - smoothstep(R * .9, R + .5, r));
  float bCap = layer * (1. - .55 * r * r / (R * R));
  em += mix(ramp(tempOf(bCap, uPlasma2.y)), N2CAP, uEarly) * uCapTint * uPlasma.x * bCap;
  float s = a - hS;
  if (s > -.35) {
    // Shear layer: the cap gas turns the shoulder, separates and closes behind the capsule (the wake neck),
    // carrying ablation products from the heat shield; streaked by the flow and flickering.
    float k = smoothstep(-.2, 7., s), rs = mix(R + .14, .75, pow(k, .8)), th = .1 + .07 * max(s, 0.);
    float bSh = exp(-sq((r - rs) / th)) * exp(-max(s, 0.) / 3.) * smoothstep(-.35, .1, s);
    bSh *= .55 + .9 * textureLod(uNoise, vec2(ang * 5., s * .05 - uTime * 2.1), 0.).r;
    em += mix(ramp(tempOf(bSh, uPlasma2.z)), mix(N2CAP, N2WAKE, k), uEarly) * mix(uCapTint, uWakeTint, k) * uPlasma.y * bSh;
    // Wake: a long trail of ionised gas and ablation products, widening slowly; recirculating gas behind the
    // afterbody glows dimly. Seen at ~10 km/s its turbulence is smeared into streaks along the flow.
    float sw = max(s - 2., 0.), ww = .55 + .05 * sw;
    float bw = exp(-sw / uPlasma2.x) * exp(-2. * r * r / (ww * ww)) * smoothstep(1., 5., s) * .6 / ww;
    float st = textureLod(uNoise, vec2(ang * 9., s * .012 - uTime * 3.1), 0.).b * textureLod(uNoise, vec2(ang * 3., s * .02 - uTime * 1.3), 0.).g;
    bw *= .3 + 2.6 * st;
    float bb = .05 * exp(-max(s, 0.) / 3.) * (1. - smoothstep(rs * .8, rs, r)) * smoothstep(0., .8, s);
    // Far down the wake the gas cools and recombines: the light reddens towards the pink of nitrogen and the
    // orange of sodium from the ablator.
    vec3 wc = mix(ramp(tempOf(bw + bb, uPlasma2.z * .85)), COOL, .45 * smoothstep(8., 60., s));
    em += mix(wc, N2WAKE, uEarly) * uWakeTint * uPlasma.z * (bw + bb);
  }
  // Faint envelope: air behind the bow shock beyond the shoulder (molecular nitrogen bands).
  float env = exp(-sq((a - aShock) / .2)) * exp(-max(r - R, 0.) / 1.2) * smoothstep(R * .8, R * 1.05, r);
  em += uEnvTint * uPlasma.w * env;
  return vec4(em * uPlasma2.w, 0.);
}
#endif
`;

function volumeMaterial(uniforms, defines = {}) {
  const { noise, blackbody } = exhaustTextures();
  return new THREE.ShaderMaterial({
    defines, vertexShader: VOLUME_VERTEX, fragmentShader: VOLUME_FRAGMENT,
    uniforms: { uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uInside: { value: 0 }, uSteps: { value: 20 }, uStepLen: { value: 1 }, uHull: { value: new THREE.Vector4(1, 0, 0, 1) }, uOccA: { value: new THREE.Vector4(0, 0, 0, 0) }, uOccB: { value: new THREE.Vector4(0, 0, 0, 0) }, uNoise: { value: noise }, uRamp: { value: blackbody }, ...uniforms },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    // Premultiplied: glowing gas adds light, soot also hides what is behind it.
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor
  });
}
// The hull mesh: camera position in its own frame every time it is drawn (double precision: the world frame
// is in thousands of km), and back faces without depth test when the camera is inside.
function volumeMesh(material) {
  const mesh = new THREE.Mesh(exhaustTextures().hull, material), inverse = new THREE.Matrix4(), cam = new THREE.Vector3();
  mesh.frustumCulled = false;
  mesh.onBeforeRender = (renderer, scene, camera) => {
    const u = material.uniforms, h = u.uHull.value;
    inverse.copy(mesh.matrixWorld).invert(); cam.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverse); u.uCam.value.copy(cam);
    const margin = 3 * camera.near / Math.max(1e-30, mesh.matrixWorld.getMaxScaleOnAxis()), a = -cam.y, r = Math.hypot(cam.x, cam.z);
    const inside = a > h.z - margin && a < h.w + margin && r < h.x + h.y * a + margin;
    u.uInside.value = inside ? 1 : 0; material.depthTest = !inside; u.uTime.value = performance.now() / 1000 % 3600;
  };
  return mesh;
}

// Engines and how their exhaust looks. Luminance is per metre of gas at the exit: a ray through a plume ~1 m
// across therefore sees about that luminance. Sources: see the comments of each entry.
const ENGINES = {
  // F-1, RP-1/LOX (Saturn V S-IC). Sea level: an incandescent soot flame, overexposed white-yellow in every
  // Apollo photograph, opaque enough to hide what is behind it, with the dark turbine-exhaust collar at the
  // nozzles. With altitude the underexpanded exhaust balloons into the huge translucent bulb filmed at staging.
  // Exposure licence: ~2400 K soot is some 60× brighter than a sunlit white surface; the flame's surface is held
  // at ~8 (j / sigma), which any daylight exposure still clips to white, so the bloom stays the flame's own size.
  f1: { steps: 20, flat: 1, j: 2.4, T0: 2450, turb: 0.35, sigma: 0.3, film: [3.0, 0.3, 0.012, 3.5], tint: [1, 1, 1, 0] },
  // J-2, LH2/LOX (S-II, S-IVB). Water vapour: almost no visible emission, a faint violet-blue glow at the exit,
  // and in sunlight a faint fan of condensed ice. No shock diamonds in vacuum.
  j2: { steps: 14, flat: 0, j: 0.16, T0: 3000, turb: 0, length: 4.5, core: [0.6, 0.8], spread: 0.3, streaks: 0.4, tint: [0.66, 0.66, 1.2, 1], haze: [0.05, 22, 0.55, 0.5] },
  // Hypergolic engines (Aerozine-50/N2O4) in vacuum: a pale, translucent yellow-orange cone that fades within a
  // nozzle length or two, like the Shuttle OMS (same AJ10 family as the Apollo SPS) in STS-84 photo 357-008;
  // in sunlight, a broad grey-white streaky fan of propellant droplets (STS-98 photo 324-004). Their light is not
  // a black body: T0 only sets the colour, matched to those photographs.
  sps: { steps: 16, flat: 0, j: 0.65, T0: 3100, turb: 0, length: 4, core: [0.7, 0.8], spread: 0.45, streaks: 0.45, tint: [1, 0.95, 0.97, 0], haze: [0.16, 14, 0.75, 0.5] },
  // LM descent engine: practically invisible; what the films show at landing is the blown dust.
  dps: { steps: 12, flat: 0, j: 0.32, T0: 3000, turb: 0, length: 2.6, core: [0.75, 0.5], spread: 0.4, streaks: 0.6, tint: [1, 0.95, 0.97, 0], haze: [0.05, 9, 0.7, 0.8] },
  // LM ascent engine: invisible on the Apollo 15–17 liftoff TV; a brief glow where it fires into the
  // descent stage, then only debris.
  aps: { steps: 12, flat: 0, j: 0.3, T0: 3000, turb: 0, length: 1.8, core: [0.75, 0.35], spread: 0.4, streaks: 0.6, tint: [1, 0.95, 0.97, 0], haze: [0.045, 7, 0.7, 0.8], splash: 2 },
};

class Exhaust {
  // cores: nozzle exits [x, z] around the axis; exit: their radius; base: how far the exit plane is above the
  // vehicle's lowest point (for the distance to the ground); debris: ground depth for the ascent-stage liftoff.
  constructor(kind, { cores = [[0, 0]], exit = 1, base = 0, debris = null, bell = null } = {}) {
    this.kind = kind; this.spec = ENGINES[kind]; this.cores = cores; this.exit = exit; this.base = base;
    const s = this.spec, v4 = () => ({ value: new THREE.Vector4() });
    this.uniforms = { uCores: { value: Array.from({ length: 5 }, () => new THREE.Vector4()) }, uCoreCount: { value: cores.length }, uShape: v4(), uAxial: v4(), uEmit: v4(), uFilm: v4(), uTint: { value: new THREE.Vector4(...s.tint) }, uSmoke: v4(), uHaze: v4(), uRecirc: v4(), uGround: { value: new THREE.Vector4(-1, 0, 0, 0) }, uCoreGlow: { value: new THREE.Vector2(...(this.spec.core || [0, 1])) }, uNozzle: { value: new THREE.Vector4(bell ? bell[0] : 1, bell ? bell[1] : 0, 0, bell ? 1 : 0) }, uStreaks: { value: this.spec.streaks || 0 } };
    this.material = volumeMaterial(this.uniforms); this.uniforms = this.material.uniforms; this.uniforms.uSteps.value = s.steps;
    this.mesh = volumeMesh(this.material);
    this.group = new THREE.Group(); this.group.add(this.mesh); this.group.visible = false; this.group.userData.exhaust = this;
    // Spread of the cluster at the exit plane: the envelope that the single exhausts merge into.
    this.envelope = Math.max(...cores.map(([x, z]) => Math.hypot(x, z))) + exit;
    if (debris) { this.debris = new LiftoffDebris(debris); this.debris.points.position.y = -base; this.group.add(this.debris.points); }
  }
  // level: throttle 0..1; context: altitudeKm, sunlit, groundKm (height of the vehicle's lowest point above the
  // ground, or null); length: extra length factor.
  update(level, { altitudeKm = 0, sunlit = true, groundKm = null } = {}, length = 1) {
    const on = level > 0.01; this.group.visible = on; if (!on) return;
    const u = this.uniforms, s = this.spec, h = Math.max(0, altitudeKm), sun = sunlit ? 1 : 0, exit = this.exit;
    // Start sequence of a cluster (Saturn V: centre engine first, then the outboard pairs, 1-2-2).
    let area = 0;
    this.cores.forEach(([x, z], i) => {
      const k = this.cores.length === 5 ? (i === 0 ? smoothstep(0, 0.55, level) : i < 3 ? smoothstep(0.2, 0.8, level) : smoothstep(0.38, 1, level)) : Math.min(1, level * 1.2);
      u.uCores.value[i].set(x, z, exit, k); area += exit * exit * k;
    });
    let spread = s.spread ?? 0.06, bulge = 0, bulgeLength = 30, L = (s.length ?? 35) * length, T0 = s.T0, turb = s.turb, j = s.j * (0.35 + 0.65 * level);
    let recirc = 0, smoke = 0, merge = this.cores.length > 1 ? (this.kind === 'f1' ? 12 : 8) : 1;
    if (this.kind === 'f1') {
      // Ambient pressure falls ~e-fold every 7 km: by 40–65 km the exhaust leaves the nozzles far underexpanded and
      // swells into a bulb many times the stage's width; with no air left to burn in, it cools to orange, and part
      // of it flows back up around the base (plume-induced separation, seen in the Apollo staging films).
      const B = smoothstep(10, 60, h) ** 1.2, high = smoothstep(25, 60, h);
      spread = 0.06 + 0.1 * B; bulge = 55 * B; j *= 1 + 0.6 * B; L = (35 + 90 * B) * length; T0 = 2450 - 350 * smoothstep(15, 45, h);
      turb = 0.35 - 0.2 * B; recirc = 0.6 * high; smoke = 1 - smoothstep(8, 30, h);
      u.uFilm.value.set(s.film[0], s.film[1], s.film[2], s.sigma);
      u.uAxial.value.set(L, merge, s.film[3], s.flat);
    } else {
      u.uFilm.value.set(0, 1, 1, 0); u.uAxial.value.set(L, merge, 0, s.flat);
    }
    u.uShape.value.set(this.cores.length > 1 ? this.envelope : exit, spread, bulge, bulgeLength);
    u.uEmit.value.set(j, T0, turb, area);
    // Daylight on the smoke: E/(4π) for an isotropic scatterer, E = 3.2 (albedo ~0.5 for soot and steam).
    u.uSmoke.value.set(smoke, 3, 0.13 * sun + 0.004, 0);
    u.uHaze.value.set(s.haze ? s.haze[0] * sun * level : 0, s.haze ? s.haze[1] * length : 1, s.haze ? s.haze[2] : 1, s.haze ? s.haze[3] : 0);
    u.uRecirc.value.set(recirc, 5, 5.1, 1.8);
    // Distance from the exit plane to the ground along the axis, and the glow where the jet hits it.
    const ground = groundKm == null ? -1 : Math.max(0.02, groundKm * 1000 + this.base);
    u.uGround.value.set(ground, ground < 0 || !s.splash ? 0 : s.splash * level * Math.exp(-ground / 0.7), 1e9, 0);
    // Hull: the frustum that holds the visible gas, no bigger (every pixel it covers is marched): out to where the
    // exhaust has faded below ~0.4 % of its brightness at the exit, 1.3 envelopes wide.
    const e = this.cores.length > 1 ? this.envelope : exit, haze = s.haze && sun ? s.haze : null;
    const reach = (length, e0, sp, limit) => { let a = 0.5; while (a < 3000 && Math.exp(-a / length) * (e0 / (e0 + a * sp)) ** 2 > limit) a *= 1.12; return a; };
    const width = a => e + a * spread + bulge * (1 - Math.exp(-a / bulgeLength)), hazeW = a => (haze ? e * 0.8 + a * haze[2] : 0);
    const visible = this.kind === 'f1' ? L * (3.4 - 0.9 * bulge / 55) + 20 : Math.max(reach(L, e, spread, 0.004), haze ? reach(haze[1] * length, e * 0.8, haze[2], 0.01) : 0);
    const far = Math.min(ground > 0 ? ground + 0.5 : 1e9, visible); u.uGround.value.z = this.kind === 'f1' ? visible : 1e9;
    // The tightest cone over a concave profile (the bulb saturates) is its tangent at mid-length.
    const need = a => 1.3 * Math.max(width(a), hazeW(a)), mid = far / 2, eps = Math.max(0.5, far * 0.01);
    const k = Math.max(0, (need(mid + eps) - need(mid - eps)) / (2 * eps));
    let r0 = need(mid) - k * mid; for (let i = 0; i <= 32; i++) { const a = far * i / 32; r0 = Math.max(r0, need(a) - k * a); }
    u.uStepLen.value = this.kind === 'f1' ? 1.5 : exit * 0.3;
    // Upstream of the exit the hull must still enclose the gas (inside the bell, or recirculating around the
    // stage) with a positive radius: a cone that crosses its own axis folds over and draws pixels twice.
    const top = recirc > 0 ? -26 : this.uniforms.uNozzle.value.w > 0 ? -this.uniforms.uNozzle.value.x : 0;
    const r0top = Math.max(r0, (recirc > 0 ? 5.1 + 3.6 * 1.8 : exit * 1.05) - k * top);
    u.uHull.value.set(r0top, k, top, far);
    u.uOccA.value.set(5.05, 0, recirc > 0 ? -400 : 0, recirc > 0 ? -5.9 : 0); // the S-IC itself, above its base
    if (this.debris) this.debris.update(level, h, sun);
  }
}

// Lunar liftoff: the ascent engine firing into the descent stage tears off foil and paint that fly out in
// straight ballistic arcs (no air) under lunar gravity, glinting in the Sun as they tumble (Apollo 15–17 TV).
class LiftoffDebris {
  constructor(groundDepth, count = 240) {
    const rnd = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(91), start = new Float32Array(count * 3), vel = new Float32Array(count * 3), spin = new Float32Array(count * 4), kind = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const az = rnd() * Math.PI * 2, el = (-8 + rnd() * 50) * Math.PI / 180, v = 3 + 23 * rnd() ** 1.6, r = 0.4 + 1.7 * rnd();
      start.set([Math.cos(az) * r, -0.15 - rnd() * 0.6, Math.sin(az) * r], i * 3);
      vel.set([Math.cos(az) * Math.cos(el) * v, Math.sin(el) * v, Math.sin(az) * Math.cos(el) * v], i * 3);
      spin.set([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, 4 + 18 * rnd()], i * 4);
      kind.set([0.03 + 0.14 * rnd() ** 2, rnd() < 0.6 ? 0 : rnd() < 0.7 ? 1 : 2], i * 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(start, 3)); g.setAttribute('aVel', new THREE.BufferAttribute(vel, 3));
    g.setAttribute('aSpin', new THREE.BufferAttribute(spin, 4)); g.setAttribute('aKind', new THREE.BufferAttribute(kind, 2));
    this.uniforms = { uTau: { value: 0 }, uLift: { value: 0 }, uGround: { value: groundDepth }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uCam: { value: new THREE.Vector3() }, uSunlit: { value: 1 }, uViewport: { value: new THREE.Vector2(1, 1) } };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute vec3 aVel; attribute vec4 aSpin; attribute vec2 aKind;
        uniform float uTau, uLift, uGround, uSunlit; uniform vec3 uSun, uCam; uniform vec2 uViewport;
        varying vec3 vCol;
        void main() {
          const float G = 1.62; // lunar gravity, m/s²
          float h0 = position.y + uGround, land = (aVel.y + sqrt(aVel.y * aVel.y + 2. * G * max(h0, 0.))) / G, t = min(uTau, land);
          vec3 p = position + aVel * t; p.y -= .5 * G * t * t; p.y = max(p.y, -uGround); p.y -= uLift;
          vec4 mv = modelViewMatrix * vec4(p, 1.);
          gl_Position = projectionMatrix * mv;
          float px = projectionMatrix[1][1] * uViewport.y * .5 / max(-mv.z, 1e-20), size = aKind.x * length(modelViewMatrix[0].xyz) * px;
          gl_PointSize = clamp(size, 1.5, 6.);
          // Flat flake tumbling about a random axis: diffuse light, and a glint when its normal bisects Sun and eye.
          vec3 ax = normalize(aSpin.xyz + vec3(1e-4)), n0 = normalize(cross(ax, abs(ax.y) < .9 ? vec3(0., 1., 0.) : vec3(1., 0., 0.)));
          float ang = aSpin.w * t; vec3 n = n0 * cos(ang) + cross(ax, n0) * sin(ang);
          vec3 v = normalize(uCam - p + vec3(1e-6)), hv = normalize(uSun + v + vec3(1e-6));
          vec3 albedo = aKind.y < .5 ? vec3(.85, .56, .2) : aKind.y < 1.5 ? vec3(.82, .82, .84) : vec3(.12, .12, .13);
          float spec = pow(abs(dot(n, hv)), 60.) * (aKind.y < 1.5 ? 14. : 2.); // crumpled foil: a broad, softened mirror lobe
          vec3 radiance = albedo * (abs(dot(n, uSun)) * 3.2 / 3.14159 + spec) * uSunlit;
          // A flake smaller than the point: its light is spread over the point's area.
          float cover = min(1., size * size / (gl_PointSize * gl_PointSize));
          vCol = radiance * cover * (1. - smoothstep(7., 11., uTau)) * step(.001, uTau);
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vCol;
        void main() { float d = length(gl_PointCoord - .5), a = 1. - smoothstep(.25, .5, d); gl_FragColor = vec4(min(vCol * a * 1.6, vec3(200.)), 1.); }`
    });
    this.points = new THREE.Points(g, material); this.points.frustumCulled = false;
    const inverse = new THREE.Matrix4(), size = new THREE.Vector2(), dir = new THREE.Vector3();
    let lights = null;
    this.points.onBeforeRender = (renderer, scene, camera) => {
      const u = this.uniforms; inverse.copy(this.points.matrixWorld).invert();
      u.uCam.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverse);
      u.uViewport.value.copy(renderer.getDrawingBufferSize(size));
      // The Sun: the strongest directional light of the scene.
      if (!lights) { lights = []; scene.traverse(o => { if (o.isDirectionalLight) lights.push(o); }); }
      const sun = lights.reduce((best, l) => (!best || l.intensity > best.intensity ? l : best), null);
      if (sun) { dir.subVectors(sun.position, sun.target.position).transformDirection(inverse); if (dir.lengthSq() > 0) u.uSun.value.copy(dir.normalize()); }
    };
  }
  // Time since ignition from the height gained: the ascent stage rises at ~1.5 m/s² at first
  // (15.6 kN on ~4.9 t, minus lunar gravity), h = a t² / 2.
  update(level, altitudeKm, sunlit) {
    const lift = altitudeKm * 1000, u = this.uniforms;
    u.uLift.value = lift; u.uTau.value = level > 0.01 ? Math.sqrt(2 * lift / 1.5) + 0.05 : 0; u.uSunlit.value = sunlit;
    this.points.visible = u.uTau.value < 11;
  }
}

// Re-entry: the gas cap on the heat shield, the shoulder shear layer, the wake, sparks of ablator, and the
// glowing shield itself. Frame: a downstream from the stagnation point (the group is turned so −Y is downstream).
class EntryPlasma {
  constructor(shape, shieldMesh) {
    this.shape = shape; this.shield = shieldMesh;
    const u = { uCM: { value: new THREE.Vector4(shape.radius, 4.69, 0.42, shape.afterbody) }, uPlasma: { value: new THREE.Vector4() }, uPlasma2: { value: new THREE.Vector4() }, uCapTint: { value: new THREE.Color() }, uWakeTint: { value: new THREE.Color() }, uEnvTint: { value: new THREE.Color() }, uEarly: { value: 0 } };
    this.material = volumeMaterial(u, { PLASMA: '' }); this.uniforms = this.material.uniforms;
    this.mesh = volumeMesh(this.material); this.uniforms.uSteps.value = 26;
    // Solid capsule: heat-shield cap (as a frustum just inside the spherical cap) and the conical afterbody.
    const R = shape.radius * 0.985;
    this.uniforms.uOccA.value.set(1.2 - 0.153 * (R - 1.2) / 0.267, (R - 1.2) / 0.267, 0.153, 0.42);
    this.uniforms.uOccB.value.set(R + 0.42 * (R - 0.42) / shape.afterbody, -(R - 0.42) / shape.afterbody, 0.42, 0.42 + shape.afterbody);
    this.sparks = makeSparks(shape);
    this.group = new THREE.Group(); this.group.rotation.x = Math.PI; this.group.position.y = shape.stagnation;
    this.group.add(this.mesh, this.sparks); this.group.visible = false;
    this.temperature = 300; this.last = 0; this.trend = 0; this.lastLevel = 0;
    this.color = new THREE.Color();
  }
  update(level, { altitudeKm = null } = {}) {
    const now = performance.now() / 1000, dt = Math.min(0.25, Math.max(0, now - (this.last || now))); this.last = now;
    // Heat-shield surface: ~3000 K at peak heating on a lunar return; the char cools slowly afterwards.
    const target = 300 + 2650 * Math.max(0, level) ** 0.6, tau = target > this.temperature ? 0.5 : 1.6;
    this.temperature += (target - this.temperature) * (1 - Math.exp(-dt / tau));
    if (dt === 0) this.temperature = target;
    const hot = this.shield?.material;
    // Exposure licence: real radiance at 3000 K is ~700× a sunlit white surface; capped near 5 so the capsule stays
    // readable inside its own glow (an auto-exposed camera would darken everything else instead).
    if (hot?.emissive) { const glow = 5 * Math.exp(WIEN * (1 / 2950 - 1 / this.temperature)); blackbodyColor(this.temperature, hot.emissive); hot.emissiveIntensity = glow; }
    this.trend = level > this.lastLevel + 1e-4 ? 1 : level < this.lastLevel - 1e-4 ? -1 : this.trend; this.lastLevel = level;
    const on = level > 0.01; this.group.visible = on; if (!on) return;
    // Below ~45 km the capsule has slowed under ~2–3 km/s and the shock layer stops glowing (radio blackout ends
    // near 40 km on Apollo returns); only the cooling heat shield is left. Applied when the altitude is known.
    const u = this.uniforms, f = level ** 1.6 * (altitudeKm != null ? smoothstep(32, 50, altitudeKm) : 1);
    this.group.visible = f > 0.002; if (!this.group.visible) return;
    // Colour through the entry. Above ~80 km the thin, non-equilibrium shock layer glows in nitrogen bands (pink
    // and violet: Orion EFT-1 window frames); near peak heating the dense gas cap is white-hot and the wake carries
    // orange ablation products; as the capsule slows, everything cools to orange and red.
    const early = altitudeKm != null ? smoothstep(72, 92, altitudeKm) : (this.trend > 0 ? 1 - smoothstep(0.25, 0.8, level) : 0);
    const late = altitudeKm != null ? 1 - smoothstep(45, 62, altitudeKm) : (this.trend < 0 ? 1 - smoothstep(0.2, 0.75, level) : 0);
    u.uEarly.value = early;
    u.uCapTint.value.setRGB(1, 1, 1).lerp(this.color.setRGB(1, 0.86, 0.66), late);
    u.uWakeTint.value.setRGB(1, 1, 1).lerp(this.color.setRGB(1.1, 0.8, 0.75), late * 0.6);
    u.uEnvTint.value.setRGB(1, 0.5, 1.3);
    const flick = 1 + 0.05 * Math.sin(now * 37) + 0.04 * Math.sin(now * 91 + 1.7) + 0.03 * Math.sin(now * 13.3);
    u.uPlasma.value.set(2.4 * f, 0.75 * f, 0.38 * f, 0.08 * f * (0.4 + early));
    u.uPlasma2.value.set(6 + 24 * level, 4300 + 2400 * level * (1 - 0.4 * late), 2700 + 900 * level, flick);
    const length = 12 + 110 * level;
    u.uHull.value.set(2.95, 0.045, -0.75, length);
    const s = this.sparks.material.uniforms; s.uLevel.value = level; s.uTime.value = now % 3600;
  }
}
// Incandescent fragments of ablator shed at the shoulder and dragged downstream (thousands of m/s² in the
// shear layer: they leave in a tenth of a second). Drawn as streaks one exposure (1/60 s) long.
function makeSparks(shape, count = 90) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3)); geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const rnd = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(7), seed = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) seed.set([rnd(), rnd(), rnd(), rnd()], i * 4);
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4)); geometry.instanceCount = count;
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uLevel: { value: 0 }, uRadius: { value: shape.radius }, uRamp: { value: exhaustTextures().blackbody }, uViewport: { value: new THREE.Vector2(1, 1) } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute vec4 aSeed; uniform float uTime, uLevel, uRadius; uniform vec2 uViewport; uniform sampler2D uRamp;
      varying float vU; varying vec3 vCol;
      vec3 at(float t, float g, float az, float drift) {
        float a = .42 + .5 * g * t * t, k = smoothstep(0., 8., a), r = mix(uRadius + .2, .9, k) + drift * a * .03;
        return vec3(cos(az) * r, -a, sin(az) * r);
      }
      void main() {
        float life = mix(.12, .3, aSeed.z), cycle = uTime / life + aSeed.x, ph = fract(cycle), n = floor(cycle);
        float az = 6.2831853 * fract(aSeed.y + n * .618034), g = mix(800., 3500., fract(aSeed.w + n * .3713)), drift = fract(aSeed.z * 7.1 + n * .29) * 2. - 1.;
        // More spallation the hotter the shield: the number of live sparks follows the heating.
        float live = step(fract(aSeed.w * 13.7 + n * .4142), uLevel * uLevel);
        float t = ph * life;
        vec3 h0 = at(t, g, az, drift), t0 = at(max(t - 1. / 60., 0.), g, az, drift);
        vec4 head = modelViewMatrix * vec4(h0, 1.), tail = modelViewMatrix * vec4(t0, 1.);
        vec4 P = mix(tail, head, position.x);
        // View space can be in units of 1000 km: no absolute epsilons on depth.
        bool front = head.z < 0. && tail.z < 0.;
        vec2 sh = front ? head.xy / -head.z - tail.xy / -tail.z : vec2(1., 0.);
        vec2 dir = dot(sh, sh) > 1e-14 ? normalize(sh) : vec2(1., 0.);
        float px = 2. * abs(P.z) / (projectionMatrix[1][1] * uViewport.y);
        P.xy += vec2(-dir.y, dir.x) * position.y * px * 1.1;
        gl_Position = front ? projectionMatrix * P : vec4(2., 2., 2., 1.);
        vU = position.y;
        // Cooling from ~3000 K; a streak spreads the fragment's light over its length (motion blur).
        float T = 3100. - 1100. * ph, len = max(length(h0 - t0), .05); // metres
        vCol = texture2D(uRamp, vec2(clamp((1250. - 1e6 / T) / 1150., 0., 1.), .5)).rgb * exp(25924. * (1. / 3100. - 1. / T)) * live * min(6., 2.2 / len) * (1. - ph);
      }`,
    fragmentShader: /* glsl */`
      varying float vU; varying vec3 vCol;
      void main() { gl_FragColor = vec4(vCol * exp(-3. * vU * vU), 1.); } // additive: src·alpha + dst`
  });
  const sparks = new THREE.Mesh(geometry, material); sparks.frustumCulled = false;
  const size = new THREE.Vector2(); sparks.onBeforeRender = renderer => material.uniforms.uViewport.value.copy(renderer.getDrawingBufferSize(size));
  return sparks;
}
function exhaust(kind, options) { return new Exhaust(kind, options).group; }

// ---- Command and Service Module (CM apex at +Y) ----
function buildCM(m, { shield = true, boostCover = false } = {}, nasa = null) {
  const g = new THREE.Group();
  if (nasa && !boostCover) {
    g.add(nasaPart(nasa.csm.cm, m));
    if (shield) add(g, new THREE.SphereGeometry(4.69, 64, 8, 0, Math.PI * 2, Math.PI - 0.432, 0.432), m.heatShield, [0, 4.69 - 0.42 + nasa.csm.base, 0]).userData.shield = true;
    g.userData.base = nasa.csm.base; g.userData.apex = nasa.csm.apex; return g;
  }
  const r = 1.955, h = 3.23;
  add(g, cyl(0.42, r, h, 64), boostCover ? m.white : m.mirror, [0, h / 2, 0]);
  add(g, cyl(0.42, 0.42, 0.12, 32), m.aluminium, [0, h + 0.06, 0]);
  add(g, cyl(0.06, 0.12, 0.62, 12), m.aluminium, [0, h + 0.42, 0]);
  if (!boostCover) {
    for (const a of [-0.5, 0.5]) add(g, new THREE.BoxGeometry(0.26, 0.3, 0.04), m.glass, [Math.sin(a) * 1.35, 1.75, Math.cos(a) * 1.35], [-0.58, a, 0]);
    add(g, new THREE.BoxGeometry(0.62, 0.56, 0.04), m.charcoal, [0, 1.25, 1.55], [-0.58, 0, 0]);
  }
  // Heat shield: shallow spherical cap under the base.
  if (shield) { const cap = add(g, new THREE.SphereGeometry(4.69, 64, 8, 0, Math.PI * 2, Math.PI - 0.432, 0.432), m.heatShield, [0, 4.69 - 0.42, 0]); cap.userData.shield = true; }
  g.userData.base = 0; g.userData.apex = h; return g;
}
export function buildSM(m, nasa = null) {
  if (nasa) {
    const g = new THREE.Group(); g.add(nasaPart(nasa.csm.sm, m), nasaPart(nasa.csm.bell, m));
    // Exit plane and radius of NASA's bell (the AJ10-137 exit is 2.5 m across).
    const box = new THREE.Box3(); for (const b of nasa.csm.bell.children) { if (!b.geometry.boundingBox) b.geometry.computeBoundingBox(); box.union(b.geometry.boundingBox); }
    const exit = box.isEmpty() ? 1.25 : THREE.MathUtils.clamp((box.max.x - box.min.x + box.max.z - box.min.z) / 4, 0.8, 1.6), end = box.isEmpty() ? nasa.csm.bellEnd : box.min.y;
    const engine = exhaust('sps', { exit, bell: [box.isEmpty() ? 3.2 : THREE.MathUtils.clamp(box.max.y - box.min.y, 1.5, 3.4), 0.4] }); engine.position.y = end; g.add(engine); g.userData.plume = engine; return g;
  }
  const g = new THREE.Group(), r = 1.955, h = 4.1;
  add(g, cyl(r, r, h, 64), m.aluminium, [0, -h / 2, 0]);
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + 0.3; add(g, new THREE.BoxGeometry(0.9, 2.6, 0.03), m.radiator, [Math.sin(a) * (r + 0.01), -2.4, Math.cos(a) * (r + 0.01)], [0, a, 0]); }
  add(g, cyl(r, 1.25, 0.5, 64), m.aluminium, [0, -h - 0.25, 0]);
  const bell = add(g, bellGeometry(0.36, 1.25, 2.85), m.bell, [0, -h - 0.45, 0]);
  add(g, bellGeometry(1.0, 1.26, 0.35), m.bellBand, [0, -h - 2.95, 0]);
  for (let i = 0; i < 4; i++) rcsQuad(g, m, [Math.sin(i * Math.PI / 2 + Math.PI / 4) * (r + 0.13), -0.9, Math.cos(i * Math.PI / 2 + Math.PI / 4) * (r + 0.13)], i * Math.PI / 2 + Math.PI / 4 - Math.PI / 2);
  // High-gain antenna: four dishes on a boom off the aft bulkhead.
  const boom = new THREE.Group(); boom.position.set(0, -h + 0.2, -r); boom.rotation.x = -0.9; g.add(boom);
  add(boom, cyl(0.05, 0.05, 2.6, 8), m.aluminium, [0, -1.3, 0]);
  for (const [x, y] of [[-0.42, -0.42], [0.42, -0.42], [-0.42, 0.42], [0.42, 0.42]]) add(boom, new THREE.SphereGeometry(0.4, 20, 6, 0, Math.PI * 2, 0, 0.7), m.white, [x, -2.6 + y * 0.2, y], [Math.PI / 2, 0, 0]);
  const engine = exhaust('sps', { exit: 1.26, bell: [3.2, 0.36] }); engine.position.y = -h - 3.3; g.add(engine);
  g.userData.plume = engine; g.userData.bell = bell; return g;
}
// CSM with the CM apex at +3.2 m and the SM below the origin.
function buildCSM(m, nasa = null) { const g = new THREE.Group(), cm = buildCM(m, { shield: false }, nasa), sm = buildSM(m, nasa); g.add(cm, sm); g.userData.plume = sm.userData.plume; return g; }

// ---- Lunar Module ----
export function buildDescentStage(m, nasa = null) {
  if (nasa) {
    const g = nasaPart(nasa.lm.descent, m, true), engine = exhaust('dps', { exit: 0.75, base: 1.15, bell: [0.9, 0.35] }); engine.position.y = 1.15; g.add(engine);
    g.userData.plume = engine; g.userData.height = nasa.lm.deck; return g;
  }
  m = m.lm || m;
  const g = new THREE.Group(), y0 = 1.5, hh = 1.65;
  const oct = new THREE.Shape(); const R = 2.28;
  for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2 + Math.PI / 8, p = [Math.cos(a) * R, Math.sin(a) * R]; i ? oct.lineTo(...p) : oct.moveTo(...p); }
  const body = add(g, new THREE.ExtrudeGeometry(oct, { depth: hh, bevelEnabled: false }), m.gold, [0, y0 + hh, 0], [Math.PI / 2, 0, 0]);
  body.material = [m.amber, m.gold];
  add(g, new THREE.BoxGeometry(4.0, 0.06, 4.0), m.black, [0, y0 - 0.02, 0]);
  add(g, bellGeometry(0.4, 0.78, 1.0), m.bell, [0, y0, 0]);
  // Four legs: primary strut, two secondary struts, footpad and (on three legs) the contact probe.
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2, dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a)), side = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
    const pad = dir.clone().multiplyScalar(4.25).setY(0.22), top = dir.clone().multiplyScalar(2.0).setY(y0 + hh - 0.3);
    strut(g, top, pad.clone().setY(0.42), 0.085, m.gold);
    for (const s of [-1, 1]) strut(g, pad.clone().setY(0.62).addScaledVector(dir, -0.12), dir.clone().multiplyScalar(1.85).addScaledVector(side, s * 1.0).setY(y0 + 0.05), 0.045, m.aluminium);
    add(g, cyl(0.47, 0.42, 0.2, 28), m.lmPad || m.aluminium, [pad.x, 0.1, pad.z]);
    if (i !== 0) strut(g, pad.clone().setY(0.2), pad.clone().addScaledVector(dir, 0.35).setY(-1.45), 0.012, m.aluminium);
  }
  // Porch and ladder on the forward (+Z) leg.
  add(g, new THREE.BoxGeometry(0.9, 0.05, 0.7), m.aluminium, [0, y0 + hh + 0.02, 2.45]);
  for (let k = 0; k < 9; k++) add(g, cyl(0.02, 0.02, 0.5, 6), m.aluminium, [0, y0 + hh - 0.25 - k * 0.3, 2.55 + k * 0.2], [0, 0, Math.PI / 2]);
  const dust = new THREE.Group(); g.add(dust);
  const engine = exhaust('dps', { exit: 0.78, base: y0 - 1.0, bell: [1.0, 0.4] }); engine.position.y = y0 - 1.0; g.add(engine);
  g.userData.plume = engine; g.userData.height = y0 + hh;
  return g;
}
export function buildAscentStage(m, nasa = null) {
  if (nasa) { const g = nasaPart(nasa.lm.ascent, m, true), engine = exhaust('aps', { exit: 0.43, base: 0.05, debris: nasa.lm.deck, bell: [0.5, 0.2] }); engine.position.y = 0.05; g.add(engine); g.userData.plume = engine; return g; }
  m = m.lm || m;
  const g = new THREE.Group();
  // Cabin: faceted prism seen from the front.
  const s = new THREE.Shape(); [[-1.15, 0], [1.15, 0], [1.4, 0.55], [1.4, 1.7], [1.0, 2.35], [-1.0, 2.35], [-1.4, 1.7], [-1.4, 0.55]].forEach((p, i) => i ? s.lineTo(...p) : s.moveTo(...p));
  const cabin = add(g, new THREE.ExtrudeGeometry(s, { depth: 2.0, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2 }), m.greyPanel, [0, 0.15, -1.0]);
  cabin.material = [m.greyPanel, m.greyPanel];
  for (const sx of [-1, 1]) add(g, new THREE.BoxGeometry(0.04, 1.1, 1.5), m.charcoal, [1.43 * sx, 1.55, 0.05]);
  add(g, new THREE.BoxGeometry(1.9, 0.5, 0.04), m.silverFoil, [0, 2.25, 1.08]);
  // Front face: triangular windows and the forward hatch.
  for (const sx of [-1, 1]) { const tri = new THREE.Shape(); tri.moveTo(0, 0); tri.lineTo(0.66 * sx, 0); tri.lineTo(0.1 * sx, 0.56); tri.lineTo(0, 0); const w = add(g, new THREE.ShapeGeometry(tri), m.glass, [0.14 * sx, 1.5, 1.075]); w.material = m.glass; }
  add(g, new THREE.BoxGeometry(0.82, 0.82, 0.05), m.charcoal, [0, 0.68, 1.08]);
  add(g, new THREE.BoxGeometry(2.6, 0.3, 0.05), m.silverFoil, [0, 0.2, 1.08]);
  // Propellant-tank bulges on both sides and the aft equipment bay.
  for (const sx of [-1, 1]) { const tank = add(g, new THREE.CapsuleGeometry(0.62, 0.7, 6, 24), sx < 0 ? m.silverFoil : m.charcoal, [1.55 * sx, 1.05, -0.35], [Math.PI / 2, 0, 0]); tank.scale.set(1, 1, 0.92); }
  add(g, new THREE.BoxGeometry(2.3, 1.55, 0.85), m.charcoal, [0, 1.35, -1.45]);
  add(g, new THREE.BoxGeometry(2.0, 0.08, 0.7), m.white, [0, 2.15, -1.45]);
  // Docking tunnel, rendezvous radar, S-band antenna and VHF whips.
  add(g, cyl(0.42, 0.45, 0.45, 32), m.silverFoil, [0, 2.75, 0]);
  add(g, cyl(0.12, 0.42, 0.2, 24), m.charcoal, [0, 3.06, 0]);
  const radar = add(g, new THREE.SphereGeometry(0.31, 24, 8, 0, Math.PI * 2, 0, 0.75), m.silverFoil, [0.75, 2.75, 0.75], [-1.05, 0, 0]); radar.scale.y = 0.6;
  strut(g, new THREE.Vector3(1.25, 2.3, -0.4), new THREE.Vector3(1.75, 3.0, -0.4), 0.03, m.aluminium);
  add(g, new THREE.SphereGeometry(0.33, 24, 8, 0, Math.PI * 2, 0, 0.75), m.white, [1.8, 3.05, -0.4], [0.6, 0, -0.8]);
  for (const sx of [-1, 1]) strut(g, new THREE.Vector3(0.9 * sx, 2.4, -0.9), new THREE.Vector3(1.05 * sx, 3.5, -1.1), 0.01, m.aluminium);
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) rcsQuad(g, m, [1.62 * x, 1.95, 1.08 * z], Math.atan2(z, x) * -1);
  add(g, bellGeometry(0.2, 0.43, 0.5), m.bell, [0, 0.12, 0]);
  const engine = exhaust('aps', { exit: 0.43, base: -0.38, debris: 3.15, bell: [0.5, 0.2] }); engine.position.y = -0.38; g.add(engine);
  g.userData.plume = engine;
  return g;
}
export function buildLM(m, nasa = null) {
  const g = new THREE.Group(), descent = buildDescentStage(m, nasa), ascent = buildAscentStage(m, nasa);
  ascent.position.y = descent.userData.height; g.add(descent, ascent);
  g.userData.plume = descent.userData.plume; g.userData.descent = descent; g.userData.ascent = ascent; return g;
}

// ---- Saturn V stack (y = 0 at the F-1 nozzle exits) ----
function buildSaturnV(m, { stage = 1 } = {}) {
  const g = new THREE.Group(); let y = 0, plumeAt = 0, plumeKind = null;
  if (stage === 1) {
    for (const [x, z] of [[0, 0], [2.7, 2.7], [-2.7, 2.7], [2.7, -2.7], [-2.7, -2.7]]) add(g, bellGeometry(0.55, 1.85, 5.8, 28), m.bell, [x, 6.0, z]);
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; add(g, cyl(0.6, 1.6, 5.2, 16), m.white, [Math.sin(a) * 3.9, 5.6, Math.cos(a) * 3.9]); const fin = add(g, new THREE.BoxGeometry(0.18, 3.6, 3.0), m.white, [Math.sin(a) * 6.2, 3.4, Math.cos(a) * 6.2], [0, a, 0]); fin.scale.set(1, 1, 1); }
    add(g, cyl(5.05, 5.05, 12, 64), m.quadrants, [0, 6 + 6, 0]);
    add(g, cyl(5.05, 5.05, 30, 64), m.white, [0, 6 + 12 + 15, 0]);
    add(g, cyl(5.07, 5.07, 4.5, 64), m.quadrants, [0, 6 + 21, 0]);
    y = 48; plumeAt = 0.2; plumeKind = 'f1';
  }
  if (stage <= 2) {
    const s2 = y; add(g, cyl(5.05, 5.05, 5.5, 64), m.white, [0, s2 + 2.75, 0]);
    if (stage === 2) for (const [x, z] of [[0, 0], [1.8, 1.8], [-1.8, 1.8], [1.8, -1.8], [-1.8, -1.8]]) add(g, bellGeometry(0.3, 0.95, 3.4, 24), m.bell, [x, s2 + 3.2, z]);
    add(g, cyl(5.05, 5.05, 19.3, 64), m.white, [0, s2 + 5.5 + 9.65, 0]);
    y = s2 + 24.8; if (stage === 2) { plumeAt = s2 - 0.2; plumeKind = 'j2x5'; }
    add(g, cyl(3.3, 5.05, 5.6, 64), m.white, [0, y + 2.8, 0]); y += 5.6;
  }
  if (stage === 3) { add(g, bellGeometry(0.28, 1.0, 3.4, 28), m.bell, [0, y + 3.2, 0]); plumeAt = y - 0.2; plumeKind = 'j2'; y += 3.2; }
  // S-IVB with its black aft skirt, instrument unit, SLA, then CM with boost cover and LES.
  add(g, cyl(3.3, 3.3, 3.6, 64), m.quadrants, [0, y + 1.8, 0]);
  add(g, cyl(3.3, 3.3, 14.2, 64), m.white, [0, y + 3.6 + 7.1, 0]); y += 17.8;
  add(g, cyl(3.3, 3.3, 0.9, 64), m.greyPanel, [0, y + 0.45, 0]); y += 0.9;
  add(g, cyl(1.955, 3.3, 8.5, 64), m.aluminium, [0, y + 4.25, 0]); y += 8.5;
  const cm = buildCM(m, { shield: false, boostCover: stage < 3 }); cm.position.y = y; g.add(cm); y += 3.3;
  if (stage < 3) {
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; strut(g, new THREE.Vector3(Math.sin(a) * 0.55, y, Math.cos(a) * 0.55), new THREE.Vector3(Math.sin(a) * 0.22, y + 3.0, Math.cos(a) * 0.22), 0.05, m.red); }
    add(g, cyl(0.33, 0.33, 4.7, 24), m.white, [0, y + 3.0 + 2.35, 0]);
    add(g, new THREE.ConeGeometry(0.33, 1.6, 24), m.red, [0, y + 3.0 + 4.7 + 0.8, 0]);
    y += 9.3;
  }
  const kind = plumeKind === 'f1' ? exhaust('f1', { cores: [[0, 0], [2.7, 2.7], [-2.7, -2.7], [-2.7, 2.7], [2.7, -2.7]], exit: 1.85 })
    : plumeKind === 'j2x5' ? exhaust('j2', { cores: [[0, 0], [1.8, 1.8], [-1.8, -1.8], [-1.8, 1.8], [1.8, -1.8]], exit: 0.95 }) : exhaust('j2', { exit: 0.99, bell: [3.4, 0.28] });
  kind.position.y = plumeAt; g.add(kind); g.userData.plume = kind; g.userData.height = y;
  return g;
}

// Stages left behind: the same models, without what flies on.
export function buildSpent(m, kind, nasa = null) {
  if (kind === 'sm') { const g = buildSM(m, nasa); g.userData.plume.visible = false; if (nasa) g.position.y = -nasa.csm.bellEnd / 2; return g; }
  if (kind === 'asc') return buildAscentStage(m, nasa);
  const stage = kind === 'sic' ? 1 : kind === 'sii' ? 2 : 3, top = kind === 'sic' ? 48 : kind === 'sii' ? 30.4 : 30.2;
  const g = buildSaturnV(m, { stage });
  for (const child of [...g.children]) if (child === g.userData.plume || child.position.y > top) g.remove(child);
  const centre = top / 2; for (const child of g.children) child.position.y -= centre;
  return g;
}
export function setLayer(object, layer) { object.traverse(o => o.layers.set(layer)); return object; }

// ---- Entry and recovery ----
function buildChutes(m) {
  const g = new THREE.Group(), lines = [];
  const canopy = (radius, at) => {
    const c = add(g, new THREE.SphereGeometry(radius, 48, 12, 0, Math.PI * 2, 0, 1.05), m.chute, at); c.scale.y = 0.62;
    const rim = radius * Math.sin(1.05), rimY = at[1] + radius * Math.cos(1.05) * 0.62;
    for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; lines.push(at[0] + Math.cos(a) * rim, rimY, at[2] + Math.sin(a) * rim, 0, 3.6, 0); }
    return c;
  };
  const mains = [[0, 42, 0], [13, 39, 7.5], [-13, 39, 7.5]].map(p => canopy(12.7, p));
  const drogues = [[2.5, 22, 0], [-2.5, 22, 0]].map(p => canopy(2.5, p));
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  const rig = new THREE.LineSegments(geo, m.line); g.add(rig);
  g.userData = { mains, drogues, rig }; return g;
}

const HEIGHT = { saturnV: 110.6, stage2: 80, sivb: 34, stack: 18, lm: 7, ascent: 3.8, csm: 11, cm: 3.5, cmChutes: 50 };

// A soft white point (beacon flashes, distant spacecraft).
let glow = null;
export function glowTexture() {
  if (glow) return glow;
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(.18, 'rgba(255,255,255,.55)'); r.addColorStop(.5, 'rgba(255,255,255,.08)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64); glow = new THREE.CanvasTexture(c); glow.colorSpace = THREE.SRGBColorSpace; return glow;
}
// RCS exhaust: a short, widening cone from the nozzle, seen only where the Sun lights it (level 0..1).
const JET = new THREE.CylinderGeometry(0.3, 0.035, 1.2, 12, 1, true).translate(0, 0.6, 0);
function rcsJet() {
  return new THREE.Mesh(JET, new THREE.ShaderMaterial({
    uniforms: { uLevel: { value: 0 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    vertexShader: 'varying float vY;void main(){vY=uv.y;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: 'uniform float uLevel;varying float vY;void main(){float a=uLevel*(1.-vY)*(1.-vY);gl_FragColor=vec4(vec3(1.5,1.52,1.6)*a,1.);}'
  }));
}
function flashLight(scale) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(7, 7, 7), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  s.scale.setScalar(scale); return s;
}

// One vehicle that switches configuration with the mission phase.
export class Spacecraft {
  constructor(materials, nasa = null) {
    this.m = materials; this.nasa = nasa; this.group = new THREE.Group(); this.body = new THREE.Group(); this.body.scale.setScalar(0.001); this.group.add(this.body);
    const m = materials, cfg = this.configs = {};
    cfg.saturnV = buildSaturnV(m, { stage: 1 }); cfg.stage2 = buildSaturnV(m, { stage: 2 }); cfg.sivb = buildSaturnV(m, { stage: 3 });
    for (const [k, model] of [['saturnV', cfg.saturnV], ['stage2', cfg.stage2], ['sivb', cfg.sivb]]) { const h = model.userData.height; model.position.y = -h * 0.45; }
    // Docked: the lunar module nose to nose with the command module, as after transposition and docking.
    const apex = nasa ? nasa.csm.apex + 0.15 : 3.6, lmDock = nasa ? nasa.lm.deck + nasa.lm.dock : 6.0;
    const stack = new THREE.Group(), csm1 = buildCSM(m, nasa), lm1 = buildLM(m, nasa); stack.add(csm1); lm1.rotation.x = Math.PI; lm1.position.y = apex + lmDock; stack.add(lm1); stack.position.y = -2; stack.userData.plume = csm1.userData.plume; cfg.stack = stack;
    cfg.lm = buildLM(m, nasa);
    cfg.ascent = buildAscentStage(m, nasa);
    cfg.csm = buildCSM(m, nasa);
    // The lunar rendezvous: the ascent stage and the CSM as two bodies, placed by pair() from the mission model (from
    // the climb to orbit to the injection burn: the approach, the docking, the docked stack, the jettison).
    // Lights for the night side: the LM's tracking light on its front face, the CSM's rendezvous beacon on the service
    // module (one each side), both flashing about once a second. The four RCS quads' upward jets brake toward the CSM.
    const pair = new THREE.Group(), lmP = buildAscentStage(m, nasa), csmP = buildCSM(m, nasa); pair.add(lmP, csmP);
    const tracking = flashLight(0.9); tracking.position.set(0, nasa ? 2.62 : 2.3, nasa ? 2.27 : 1.13); lmP.add(tracking);
    const beacons = [1, -1].map(s => { const b = flashLight(1.1); b.position.set(0, -0.55, s * 2.0); csmP.add(b); return b; });
    const quad = nasa ? [1.73, 1.3, 1.73] : [1.62, 2.13, 1.08];
    const jets = [[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([x, z]) => { const j = rcsJet(); j.position.set(quad[0] * x, quad[1], quad[2] * z); lmP.add(j); return j; });
    pair.userData = { plume: lmP.userData.plume, lm: lmP, csm: csmP, tracking, beacons, jets }; cfg.pair = pair; this.span = 6;
    // Entry: the capsule's own heat shield glows (a material of its own), wrapped in the plasma.
    const cm = buildCM(m, {}, nasa); cm.position.y = -1.5;
    const shield = cm.children.find(c => c.userData.shield); if (shield) shield.material = m.heatShield.clone();
    const entry = new EntryPlasma({ radius: 1.955, stagnation: cm.userData.base - 0.42, afterbody: cm.userData.apex - cm.userData.base }, shield);
    cm.add(entry.group); cm.userData.plasma = entry; cfg.cm = cm;
    const cmc = new THREE.Group(), cm2 = buildCM(m, {}, nasa); cm2.rotation.z = 0.48; cmc.add(cm2); const chutes = buildChutes(m); cmc.add(chutes); cmc.userData.chutes = chutes; cfg.cmChutes = cmc;
    for (const model of Object.values(cfg)) { model.visible = false; this.body.add(model); }
    this.context = { altitudeKm: 0, sunlit: true, groundKm: null }; this.plasmaContext = {};
    this.name = null; this.set('lm');
  }
  get height() { return (this.name === 'pair' ? this.span : HEIGHT[this.name]) / 1000; }
  // The rendezvous pair: each body's position (metres, in the vehicle's frame, which stays unrotated for this
  // configuration) and world rotation; the flashing lights (much fainter against sunlight), the RCS level (seen only in
  // sunlight), and what the shadow box and the framing must hold (both bodies while they are within ~40 m).
  pair({ lm, csm, lmQ, csmQ, showLm = true, showCsm = true, time = performance.now() / 1000, sunlit = 1, rcs = 0 }) {
    const P = this.configs.pair.userData;
    P.lm.position.copy(lm); P.lm.quaternion.copy(lmQ); P.lm.visible = showLm;
    P.csm.position.copy(csm); P.csm.quaternion.copy(csmQ); P.csm.visible = showCsm;
    const flash = phase => { const f = (((time + phase) % 1) + 1) % 1; return f < 0.12 ? Math.exp(-f * 30) : 0; }, night = 1 - 0.85 * sunlit;
    P.tracking.material.opacity = flash(0) * night; for (const b of P.beacons) b.material.opacity = flash(0.47) * night;
    P.jets.forEach((j, i) => { j.material.uniforms.uLevel.value = rcs * sunlit * (0.8 + 0.2 * Math.sin(time * 53 + i * 1.7)); });
    const d = lm.distanceTo(csm); this.span = showCsm && d < 40 ? Math.max(8, d + 12) : 6;
  }
  // Where the ascent stage sits on the descent stage, km.
  get ascentBase() { return (this.nasa ? this.nasa.lm.deck : 3.15) / 1000; }
  set(name) {
    if (name === this.name) return; if (this.name) this.configs[this.name].visible = false;
    this.name = name; this.configs[name].visible = true;
  }
  // engine: 0..1 throttle of the active configuration's engine(s). context (optional, remembered between calls):
  // altitudeKm (shapes the F-1 plume and times the lunar liftoff debris), sunlit (sunlight on the exhaust),
  // groundKm (height of the vehicle's lowest point above the ground or pad deck; null in flight).
  engine(level, context) {
    if (context) this.context = { ...this.context, ...context };
    const p = this.configs[this.name].userData.plume; if (!p) return;
    p.userData.exhaust.update(level, this.context, this.plumeLength ?? 1);
  }
  // plasma: 0..1 entry heating; context (optional, remembered): altitudeKm, for the colour of the shock layer
  // (nitrogen pink above ~80 km, white-hot at peak, orange late) and its fade below ~45 km.
  plasma(level, context) {
    if (context) this.plasmaContext = { ...this.plasmaContext, ...context };
    this.configs.cm.userData.plasma.update(level, this.plasmaContext);
  }
  chutes(stage) {
    const c = this.configs.cmChutes.userData.chutes;
    c.userData.drogues.forEach(d => d.visible = stage === 'drogue'); c.userData.mains.forEach(d => { d.visible = stage === 'main'; d.scale.setScalar(stage === 'main' ? 1 : 0.2); d.scale.y = 0.62; });
    c.userData.rig.visible = stage === 'main';
  }
}
