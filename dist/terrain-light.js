import * as THREE from 'three';

// Sunlight on the relief, without a shadow map. At the poles the Sun stands 0-7° high: a shadow-map texel then
// stretches into a strip 8-60 times longer on the ground (1/sin of the elevation), which combs the far slopes.
// Instead, each ground point marches its own ray toward the Sun over the heightfields (the 800 m landing patch,
// the 20 km inner DEM, the 100 km tile and the 400 km context, finest first) and keeps the highest horizon angle;
// the visible share of the solar disc (0.533°, radius 0.2665°) is then the exact soft penumbra. The result is
// baked into one visibility texture per heightfield, only when the Sun or the relief change.
// Heights include the curvature drop of the Moon (terrain.heightAt), so the test is a ray against the real
// surface in the site frame: no local-vertical correction is needed. Units: km.
export const TERRAIN_LIGHT = {
  heightSize: 512, landingHeightSize: 512, lowHeightSize: 384,   // the DEMs hold <= 769 samples a side; 512 keeps a site change fast
  // Visibility texels: landing 1.6 m, inner 39 m (the DEM's own 40 m), tile 390 m, context 1.6 km (low power: half).
  visibility: [512, 512, 256, 256], lowVisibility: [256, 256, 128, 128],
  // While the Sun moves (time playback) the bake runs only after a 0.03 deg step or 250 ms, one grid per frame.
  minStepRad: 5e-4, minIntervalMs: 250,
  raySteps: 448, stepGrowth: .028,           // a step is max(0.6 texel, 2.8 % of the distance): ~300 steps to 200 km
  solarRadius: 0.2665 * Math.PI / 180, surfaceBiasKm: 0.00012, seamTexels: 3,
};
// Shadow map for small casters only (astronaut, LM, rocks, clasts) in a box around the walker.
export const NEAR_SHADOW = { halfWidthKm: .045, halfHeightKm: .016, size: 2048, lowSize: 1024, normalBiasKm: .000006, bias: -.000002 };

const VERTEX = `out vec2 bakeUv;
void main(){bakeUv=uv;gl_Position=vec4(position.xy,0.,1.);}`;
const FRAGMENT = `precision highp float;
precision highp int;
in vec2 bakeUv;
out vec4 result;
uniform sampler2D height0,height1,height2,height3;
uniform vec4 halves,sizes;
uniform vec3 sun;
uniform float outputHalf,solarRadius,surfaceBias,topKm;
float halfAt(int g){return g==0?halves.x:g==1?halves.y:g==2?halves.z:halves.w;}
float sizeAt(int g){return g==0?sizes.x:g==1?sizes.y:g==2?sizes.z:sizes.w;}
float fetchH(int g,ivec2 p){
  if(g==0)return texelFetch(height0,p,0).r;
  if(g==1)return texelFetch(height1,p,0).r;
  if(g==2)return texelFetch(height2,p,0).r;
  return texelFetch(height3,p,0).r;
}
// Finest grid that holds p with a texel of margin (grids are concentric squares; half 0 = absent).
int gridAt(vec2 p){
  float a=max(abs(p.x),abs(p.y));
  for(int g=0;g<3;g++){float h=halfAt(g);if(h>0.&&a<h*(1.-2./sizeAt(g)))return g;}
  return 3;
}
// Bilinear height (samples sit at -half + i * 2 half / n).
float heightIn(int g,vec2 p){
  float n=sizeAt(g),h=halfAt(g);
  vec2 f=clamp((p+h)*n/(2.*h),vec2(0.),vec2(n-1.001));
  ivec2 a=ivec2(floor(f));vec2 w=fract(f);
  return mix(mix(fetchH(g,a),fetchH(g,a+ivec2(1,0)),w.x),mix(fetchH(g,a+ivec2(0,1)),fetchH(g,a+ivec2(1,1)),w.x),w.y);
}
// Share of the solar disc above a horizon (both in radians of elevation): circular-segment area.
float disc(float horizon,float elevation){
  float q=clamp((elevation-horizon)/solarRadius,-1.,1.);
  return (acos(-q)+q*sqrt(max(0.,1.-q*q)))/3.14159265;
}
void main(){
  vec2 origin=(bakeUv*2.-1.)*outputHalf;
  float flat_=length(sun.xz),elevation=atan(sun.y,max(flat_,1e-9));
  if(elevation-solarRadius>1.2){result=vec4(1.);return;}
  if(elevation+solarRadius<-.2){result=vec4(0.,0.,0.,1.);return;}
  vec2 dir=flat_>1e-8?sun.xz/flat_:vec2(1.,0.);
  int g0=gridAt(origin);
  float h0=heightIn(g0,origin)+surfaceBias;
  float tanTop=tan(elevation+solarRadius),tanLow=tan(elevation-solarRadius),best=-1e9;
  // Distance to the edge of the outermost grid along the ray.
  vec2 inv=1./max(abs(dir),vec2(1e-9)),edge=(vec2(halves.w)-origin*sign(dir))*inv;
  float reach=min(edge.x,edge.y),t=.5*2.*halfAt(g0)/sizeAt(g0);
  for(int i=0;i<${TERRAIN_LIGHT.raySteps};i++){
    if(t>=reach)break;
    vec2 p=origin+dir*t;int g=gridAt(p);
    best=max(best,(heightIn(g,p)-h0)/t);
    // Whole disc hidden; or nothing farther can rise above both the best horizon so far and the disc's lower limb.
    if(best>=tanTop||(topKm-h0)/t<max(best,tanLow))break;
    t+=max(.6*2.*halfAt(g)/sizeAt(g),t*${TERRAIN_LIGHT.stepGrowth});
  }
  result=vec4(disc(atan(best),elevation),0.,0.,1.);
}`;

// Heights of one grid as a float texture (R), sampled by texelFetch (float32 is not filterable everywhere).
function heightTexture(half, n, height) {
  const data = new Float32Array(n * n), step = 2 * half / n; let top = -Infinity;
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) { const h = height(-half + x * step, -half + z * step); data[z * n + x] = h; if (h > top) top = h; }
  const texture = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.FloatType);
  texture.minFilter = texture.magFilter = THREE.NearestFilter; texture.generateMipmaps = false; texture.needsUpdate = true;
  texture.userData.top = top;
  return texture;
}

const LIGHT_GLSL = `
uniform sampler2D terrainVisibility0,terrainVisibility1,terrainVisibility2,terrainVisibility3;
uniform vec4 terrainHalves,terrainBlend;
uniform vec3 terrainSunView;
varying vec2 terrainPosition;
float terrainCascade(sampler2D image,vec2 p,float halfKm){return texture2D(image,p/(2.*halfKm)+.5).r;}
// Finest cascade wins, blended over its last few texels.
float terrainSunVisibility(vec2 p){
  float a=max(abs(p.x),abs(p.y)),v=terrainCascade(terrainVisibility3,p,max(terrainHalves.w,1e-4));
  if(terrainHalves.z>0.){float w=clamp((terrainHalves.z-a)/terrainHalves.z*terrainBlend.z,0.,1.);if(w>0.)v=mix(v,terrainCascade(terrainVisibility2,p,terrainHalves.z),w);}
  if(terrainHalves.y>0.){float w=clamp((terrainHalves.y-a)/terrainHalves.y*terrainBlend.y,0.,1.);if(w>0.)v=mix(v,terrainCascade(terrainVisibility1,p,terrainHalves.y),w);}
  if(terrainHalves.x>0.){float w=clamp((terrainHalves.x-a)/terrainHalves.x*terrainBlend.x,0.,1.);if(w>0.)v=mix(v,terrainCascade(terrainVisibility0,p,terrainHalves.x),w);}
  return clamp(v,0.,1.);
}`;

export class TerrainLight {
  constructor(renderer, { lowPower = false } = {}) {
    this.renderer = renderer; this.lowPower = lowPower; this.grids = [null, null, null, null]; this.dirty = false;
    this.fallback = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); this.fallback.needsUpdate = true;
    this.zero = new THREE.DataTexture(new Float32Array([0]), 1, 1, THREE.RedFormat, THREE.FloatType); this.zero.needsUpdate = true;
    this.uniforms = { terrainHalves: { value: new THREE.Vector4() }, terrainBlend: { value: new THREE.Vector4(1, 1, 1, 1) }, terrainSunView: { value: new THREE.Vector3(0, 1, 0) } };
    for (let i = 0; i < 4; i++) this.uniforms[`terrainVisibility${i}`] = { value: this.fallback };
    this.sun = new THREE.Vector3(0, 1, 0); this.bakedSun = null; this.queue = []; this.force = true; this.lastBake = -1e9;
    this.bake = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERTEX, fragmentShader: FRAGMENT, depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: { height0: { value: this.zero }, height1: { value: this.zero }, height2: { value: this.zero }, height3: { value: this.zero },
        halves: this.uniforms.terrainHalves, sizes: { value: new THREE.Vector4(1, 1, 1, 1) }, sun: { value: new THREE.Vector3(0, 1, 0) }, outputHalf: { value: 1 },
        solarRadius: { value: TERRAIN_LIGHT.solarRadius }, surfaceBias: { value: TERRAIN_LIGHT.surfaceBiasKm }, topKm: { value: 0 } } });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bake); this.quad.frustumCulled = false;
    this.bakeScene = new THREE.Scene(); this.bakeScene.add(this.quad); this.bakeCamera = new THREE.Camera();
  }
  replaceGrid(i, half, size, sample) {
    const old = this.grids[i]; if (old) { old.height.dispose(); old.target.dispose(); }
    this.grids[i] = null; this.uniforms.terrainHalves.value.setComponent(i, 0);
    this.uniforms[`terrainVisibility${i}`].value = this.fallback; this.bake.uniforms[`height${i}`].value = this.zero;
    if (half > 0) {
      const n = (this.lowPower ? TERRAIN_LIGHT.lowVisibility : TERRAIN_LIGHT.visibility)[i];
      const height = heightTexture(half, size, sample);
      const target = new THREE.WebGLRenderTarget(n, n, { depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      this.grids[i] = { half, height, target }; this.uniforms.terrainHalves.value.setComponent(i, half);
      this.uniforms.terrainBlend.value.setComponent(i, n / (2 * TERRAIN_LIGHT.seamTexels));
      this.bake.uniforms.sizes.value.setComponent(i, size); this.bake.uniforms[`height${i}`].value = height;
    }
    this.bake.uniforms.topKm.value = Math.max(-1e3, ...this.grids.filter(Boolean).map(g => g.height.userData.top));
    this.dirty = this.force = true;
  }
  setTerrain(terrain) {
    const n = this.lowPower ? TERRAIN_LIGHT.lowHeightSize : TERRAIN_LIGHT.heightSize, h = (x, z) => terrain.heightAt(x, z);
    if (this.landingGrid && this.grids[0] !== this.landingGrid) { this.landingGrid.height.dispose(); this.landingGrid.target.dispose(); }
    this.landingGrid = null; this.landingOn = true; this.replaceGrid(0, 0);
    this.replaceGrid(1, terrain.inner ? terrain.inner.extent / 2 : 0, n, h);
    this.replaceGrid(2, terrain.extent / 2, n, h);
    this.replaceGrid(3, (terrain.wide?.extent || terrain.extent) / 2, n, h);
  }
  setLanding(landing) {
    if (this.landingGrid && this.grids[0] !== this.landingGrid) { this.landingGrid.height.dispose(); this.landingGrid.target.dispose(); }
    this.replaceGrid(0, landing?.half || 0, this.lowPower ? 256 : TERRAIN_LIGHT.landingHeightSize, (x, z) => landing.heightAt(x, z));
    this.landingGrid = this.grids[0]; this.landingOn = true;
  }
  // The landing grid only while the surface view shows that ground: in the relief view it only added a bake per Sun
  // step and a longer march to every other bake (playback slowed enough on a laptop to drop the resolution).
  useLanding(on) {
    const g = this.landingGrid; if (!g || this.landingOn === on) return; this.landingOn = on;
    this.grids[0] = on ? g : null; this.uniforms.terrainHalves.value.setComponent(0, on ? g.half : 0);
    this.uniforms.terrainVisibility0.value = on ? g.target.texture : this.fallback; this.bake.uniforms.height0.value = on ? g.height : this.zero;
    this.bake.uniforms.topKm.value = Math.max(-1e3, ...this.grids.filter(Boolean).map(x => x.height.userData.top));
    this.dirty = this.force = true;
  }
  setSun(direction) {
    const d = direction.clone().normalize();
    if (this.sun.distanceToSquared(d) > 1e-14) { this.sun.copy(d); this.dirty = true; }
  }
  // Multiplies the Sun (the directional light along this.sun) by the baked visibility; other lights pass.
  attach(material) {
    if (!material || material.userData.terrainLight === this) return material;
    material.userData.terrainLight = this;
    const before = material.onBeforeCompile, key = material.customProgramCacheKey.bind(material);
    material.onBeforeCompile = (shader, renderer) => {
      before.call(material, shader, renderer); Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 terrainPosition;')
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vec4 terrainWorld=vec4(transformed,1.);
#ifdef USE_INSTANCING
terrainWorld=instanceMatrix*terrainWorld;
#endif
terrainPosition=(modelMatrix*terrainWorld).xz;`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${LIGHT_GLSL}`);
      const lights = THREE.ShaderChunk.lights_fragment_begin.replace('getDirectionalLightInfo( directionalLight, directLight );',
        'getDirectionalLightInfo( directionalLight, directLight );\nif(dot(directLight.direction,terrainSunView)>.9999)directLight.color*=terrainSunVisibility(terrainPosition);');
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', lights);
    };
    material.customProgramCacheKey = () => `${key()}|terrain-horizon-2`; material.needsUpdate = true;
    return material;
  }
  // true while a bake is still due (the caller keeps drawing frames until then).
  pending() { return this.dirty || this.queue.length > 0; }
  update(camera) {
    if (camera) { camera.updateMatrixWorld(); this.uniforms.terrainSunView.value.copy(this.sun).transformDirection(camera.matrixWorldInverse); }
    if (!this.grids[3]) return false;
    const now = performance.now();
    if (this.dirty) {
      const step = this.bakedSun ? this.bakedSun.angleTo(this.sun) : Infinity;
      if (this.force || step > TERRAIN_LIGHT.minStepRad || now - this.lastBake > TERRAIN_LIGHT.minIntervalMs) {
        // A new relief bakes every grid at once; a moving Sun re-bakes one grid per frame, the finest (nearest) first.
        this.queue = [3, 2, 1, 0].filter(i => this.grids[i]); this.bakedSun = this.sun.clone(); this.lastBake = now;
        this.dirty = false; this.all = this.force; this.force = false;
      }
    }
    if (!this.queue.length) return false;
    const r = this.renderer, target = r.getRenderTarget(), face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel();
    const autoClear = r.autoClear, xr = r.xr.enabled, shadows = r.shadowMap.enabled, test = r.getScissorTest();
    try {
      r.xr.enabled = false; r.shadowMap.enabled = false; r.autoClear = true; r.setScissorTest(false);
      do {
        const i = this.queue.pop(), grid = this.grids[i]; if (!grid) continue;
        this.bake.uniforms.sun.value.copy(this.bakedSun);
        this.bake.uniforms.outputHalf.value = grid.half; r.setRenderTarget(grid.target); r.render(this.bakeScene, this.bakeCamera);
        this.uniforms[`terrainVisibility${i}`].value = grid.target.texture;
      } while (this.all && this.queue.length);
    } finally {
      r.setRenderTarget(target, face, mip); r.setScissorTest(test);
      r.autoClear = autoClear; r.xr.enabled = xr; r.shadowMap.enabled = shadows;
    }
    return true;
  }
  dispose() {
    for (const grid of new Set([...this.grids, this.landingGrid])) if (grid) { grid.height.dispose(); grid.target.dispose(); }
    this.fallback.dispose(); this.zero.dispose(); this.quad.geometry.dispose(); this.bake.dispose();
  }
}
