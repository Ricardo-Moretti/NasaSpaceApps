import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RADIUS_KM, siteBasis } from './model.js';
import { EARTH_RADIUS, APOLLO, RENDEZVOUS, moonPosition, parkingPath, parkingState, toInertial } from './mission-model.js';
import { lunarMaterial, regolithNormalMap, detailedTerrainGeometry, contextTerrainGeometry, innerTerrainGeometry, orbitalPatchGeometry, globeSpace, siteSpace, earthshineUniforms, earthshineIrradiance, DETAIL_GLOBE, DETAIL_PATCH, DETAIL_CONTEXT, DETAIL_TILE, DETAIL_INNER } from './lunar-surface.js';
import { loadStarCatalog } from './stars.js';
import { createEarthRenderer } from './earth-render.js';
import { createOcean } from './ocean.js';
import { CameraFX, EYE_STARS } from './camera-fx.js';
import { Spacecraft, createMaterials, makeEnvironment, buildDescentStage, buildSpent, setLayer, glowTexture } from './spacecraft.js';
import { LandingSite } from './landing-site.js';
import { LaunchPad, PAD_DECK } from './launch-pad.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Last pass, in display space: a little lens (chromatic fringe towards the corners, vignette) and film grain.
const FILM={
  uniforms:{tDiffuse:{value:null},uTime:{value:0},uGrain:{value:.045},uVignette:{value:.34},uFringe:{value:.011}},
  vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader:'uniform sampler2D tDiffuse;uniform float uTime,uGrain,uVignette,uFringe;varying vec2 vUv;float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}void main(){vec2 d=vUv-.5;float r2=dot(d,d);vec2 off=d*r2*uFringe;vec3 c=vec3(texture2D(tDiffuse,vUv+off).r,texture2D(tDiffuse,vUv).g,texture2D(tDiffuse,vUv-off).b);c*=1.-uVignette*smoothstep(.12,.62,r2);float n=hash(vUv*vec2(1733.,977.)+fract(uTime)*71.3)-.5;c+=n*uGrain*(1.-.6*dot(c,vec3(.299,.587,.114)));gl_FragColor=vec4(c,1.);}'
};

const asset=path=>new URL(path,import.meta.url).href;
const v=a=>new THREE.Vector3(a[0],a[2],-a[1]);
const space=a=>v(a).multiplyScalar(.001);
const Y=new THREE.Vector3(0,1,0);
const ORIGIN=new THREE.Vector3();
const SPIN=new THREE.Quaternion().setFromAxisAngle(Y,.6); // the capsule's heading on the water
// Earthshine in space: the physical value (~1e-4 of sunlight) times this stated licence, so the Moon's night side
// reads as ashen light, as in the photographs; on the ground it stays physical.
const EARTHSHINE_BOOST=400;
// The trajectory diagrams show the sky as a long exposure (~20 stops): with the white paths in frame the camera stays
// at EV 0 and the true starlight (Pogson, anchored on the Sun) would be black. Close views show the stars an eye would
// (EYE_STARS), and the camera opens at most 1 stop there (4 on the lunar night side), so the night licences (city
// lights, airglow, earthshine) are not multiplied.
const DIAGRAM_STARS=2**20,DIAGRAM_MILKY_WAY=2**22,CLOSE_MAX_EV=1;
// On the night side of the Moon the spacecraft have only the Earth's light (and their own flashing lights): there the
// camera opens up to 4 stops, a long exposure, as night pictures are made; with the earthshine licence above, the
// spacecraft and the ground below read in the ashen light instead of black.
const LUNAR_NIGHT_EV=4;
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const LUNAR_PHASES=new Set(['loi','lunarOrbit','descent','surface','ascent','lunarReturnOrbit','tei']);
const EARTH_PHASES=new Set(['liftoff','launch','earthOrbit','tli','arrival']);
// Stages where the automatic camera flies beside the spacecraft, at true scale, with the Earth or the Moon behind.
const CHASE_PHASES=new Set(['launch','earthOrbit','tli','loi','lunarOrbit','lunarReturnOrbit','tei','arrival']);
const LOCAL_VIEW=new THREE.Vector3(.032,.009,.044); // ~55 m from the lander, 13 m up: a photographer on the ground
// Same distance, placed so the Sun comes from the side and a little behind: shadows run across the picture.
function sideLitView(sun){const h=new THREE.Vector3(sun[0],0,sun[2]);if(h.lengthSq()<1e-8)return LOCAL_VIEW.clone();h.normalize().applyAxisAngle(Y,1.95);return h.multiplyScalar(.0545).setY(.009);}
const PAD_CAMERA=new THREE.Vector3(.31,.012,.27); // press site: ~410 m from the pad, on the ground
// What is dropped along the way: [model, stage, from, to, first gap (m), drift over the window (m)].
// (The ascent stage cast off in lunar orbit is part of the rendezvous pair, spacecraft.js.)
const SPENT=[['sic','launch',.23,.42,95,900],['sii','launch',.785,.97,60,700],['sivb','outbound',0,.12,45,520],['sm','arrival',0,.2,18,420]];
function mesh(geometry,material,parent,position){const m=new THREE.Mesh(geometry,material);if(position)m.position.set(...position);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
const ramp=(a,b,x)=>THREE.MathUtils.smoothstep(x,a,b);
// Roll held against the nearer body (its local vertical), as a spacecraft holds attitude in orbit: without it a model
// would turn about its own axis as its attitude sweeps around. Y along the attitude.
function holdAttitude(attitude,at,centre){
  const out=at.clone().sub(centre).normalize();let z=out.clone().addScaledVector(attitude,-out.dot(attitude));
  if(z.lengthSq()<1e-4)z=new THREE.Vector3().crossVectors(attitude,Math.abs(attitude.y)<.9?Y:new THREE.Vector3(1,0,0));z.normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(attitude,z),attitude,z));
}
const slerpDir=(a,b,k)=>a.clone().applyQuaternion(new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(a,b),k));
// Between two framings the camera swings round the moving target (direction along the arc, distance in log) instead of
// cutting across the scene, where a straight blend can leave both spacecraft out of the picture.
function orbitBlend(a,b,k){
  const target=a.target.clone().lerp(b.target,k),oa=a.position.clone().sub(a.target),ob=b.position.clone().sub(b.target);
  const la=Math.max(oa.length(),1e-12),lb=Math.max(ob.length(),1e-12),dir=slerpDir(oa.divideScalar(la),ob.divideScalar(lb),k);
  return {position:target.clone().addScaledVector(dir,Math.exp(THREE.MathUtils.lerp(Math.log(la),Math.log(lb),k))),target,up:(a.up||Y).clone().lerp(b.up||Y,k).normalize()};
}
// A spacecraft too far away to resolve: a point, drawn over the second pass (the Moon's disc is checked separately).
function makeGlint(){
  const g=new THREE.Points(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute([0,0,0],3)),new THREE.PointsMaterial({size:9,sizeAttenuation:false,map:glowTexture(),color:0xffffff,transparent:true,depthTest:false,depthWrite:false,blending:THREE.AdditiveBlending}));
  g.frustumCulled=false;g.visible=false;g.renderOrder=10;return g;
}

export class MissionScene {
  constructor(canvas,container,terrain,onError,{t=k=>k,nasa=null}={}){
    this.t=t;this.nasa=nasa;this.container=container;this.terrain=terrain;this.mode='auto';this.dirty=true;this.disposed=false;this.cameraKey='';this.textures=[];
    this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1;this.renderer.setClearColor(0x000000,0);this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFShadowMap;
    // Two passes when in space: the distant bodies first, then the spacecraft with its own depth range,
    // so a 20 m vehicle and a planet 200 km behind it can share a picture.
    this.renderer.autoClear=false;this.nearA=.0005;
    // Cinema pipeline: the bodies are drawn in linear HDR (half float, 4× MSAA) into the camera's stage (alpha =
    // coverage). The camera (camera-fx.js) meters and adapts its exposure on the GPU, adds the lens flare and puts the
    // Milky Way and the stars behind what the scene left open; bright sources bloom, ACES gives the response of film,
    // then lens and grain.
    {
      const size=this.renderer.getDrawingBufferSize(new THREE.Vector2()),hdr=this.renderer.extensions.has('EXT_color_buffer_float')||this.renderer.extensions.has('EXT_color_buffer_half_float'),type=hdr?THREE.HalfFloatType:THREE.UnsignedByteType;
      // The composer's own buffers stay single-sampled: only the bodies need the samples (a full-screen pass into a
      // 4× MSAA half-float buffer costs ~4 ms on integrated GPUs).
      this.composer=new EffectComposer(this.renderer,new THREE.WebGLRenderTarget(Math.max(1,size.x),Math.max(1,size.y),{type}));
      this.fx=new CameraFX(this.renderer);this.fx.createStageTarget({type});this.sunAU=1;
      const stage=new Pass();stage.needsSwap=false;stage.render=renderer=>{renderer.setRenderTarget(this.fx.stage);renderer.clear();this.draw();};
      this.bloom=new UnrealBloomPass(new THREE.Vector2(size.x/2,size.y/2),.5,.75,1);this.film=new ShaderPass(FILM);
      // The Sun as a lens sees it: a crisp disc, a starburst and a few ghosts. The default halo and veil (a 1:1 model
      // of a cheap lens's scatter) turned it into a fog ball a fifth of the frame wide.
      Object.assign(this.fx.params,{halo:.15,veil:.04,ghosts:.45,spikes:.75,flare:.8});
      for(const pass of [stage,this.fx.pass,this.bloom,new OutputPass(),this.film])this.composer.addPass(pass);
    }
    this.scene=new THREE.Scene();this.camera=new THREE.PerspectiveCamera(45,1,.001,10000);this.controls=new OrbitControls(this.camera,canvas);this.controls.enableDamping=false;this.controls.addEventListener('change',()=>{this.dirty=true;});this.controls.addEventListener('start',()=>{this.cameraTween=null;this.manualCamera=true;});
    this.world=new THREE.Group();this.local=new THREE.Group();this.oceanGroup=new THREE.Group();this.scene.add(this.world,this.local,this.oceanGroup);
    this.sunlight=new THREE.DirectionalLight(0xfff6e4,3.2);this.sunlight.shadow.mapSize.set(4096,4096);this.sunlight.shadow.normalBias=.00004;this.sunlight.shadow.bias=-.00002;this.sunlight.layers.enableAll();this.scene.add(this.sunlight,this.sunlight.target);
    this.fill=new THREE.AmbientLight(0xa4c2df,.03);this.fill.layers.enableAll();this.scene.add(this.fill);
    // Reading light, only when the destination is in shadow; the scale label says so.
    this.earthlight=new THREE.DirectionalLight(0x9fc4ff,0);this.scene.add(this.earthlight,this.earthlight.target);
    // Light the sunlit ground below sends back up to the spacecraft (second pass only).
    this.shine=new THREE.DirectionalLight(0xffffff,0);this.shine.layers.set(1);this.scene.add(this.shine,this.shine.target);
    // Starlight and stray light: just enough to read the spacecraft inside a shadow.
    this.shade=new THREE.AmbientLight(0x93a8cc,.2);this.shade.layers.set(1);this.scene.add(this.shade);
    // Earthshine on the spacecraft near the Moon (second pass only): from the Earth, when it is above the Moon's limb.
    this.earthshineLight=new THREE.DirectionalLight(0xbcccff,0);this.earthshineLight.layers.set(1);this.scene.add(this.earthshineLight,this.earthshineLight.target);
    // On the Moon: light the sunlit regolith sends back up to the shaded side of the lander.
    this.bounce=new THREE.HemisphereLight(0x000000,0xcfc8bc,0);this.scene.add(this.bounce);
    // What polished metal reflects: regolith near the Moon, oceans and clouds near the Earth, sky over the Pacific.
    this.envs={moon:makeEnvironment(this.renderer,{ground:[.34,.33,.31]}),earth:makeEnvironment(this.renderer,{ground:[.12,.2,.34],horizon:[.4,.52,.72]}),space:makeEnvironment(this.renderer,{sky:[.02,.02,.025],ground:[.07,.07,.075]}),ocean:makeEnvironment(this.renderer,{sky:[.28,.46,.75],ground:[.03,.09,.16],horizon:[.78,.86,.95]})};
    this.materials=createMaterials(this.envs.space.texture);this.materials.onTextureLoad=()=>{this.dirty=true;};this.envName='space';
    const loader=new THREE.TextureLoader(),anisotropy=this.renderer.capabilities.getMaxAnisotropy();
    const texture=(file,srgb,error)=>{const tex=loader.load(asset(`./assets/mission/${file}`),()=>this.dirty=true,undefined,error&&(()=>onError(t(error))));if(srgb)tex.colorSpace=THREE.SRGBColorSpace;tex.anisotropy=anisotropy;this.textures.push(tex);return tex;};
    this.loadTexture=texture;this.canvas=canvas;this.onError=onError;
    this.uploads=[];this.drawn=0;this.whenReady=new Promise(resolve=>{this.onReady=resolve;});
  }
  // The heavy part, in steps with a frame for the page between them (progress 0..1); resolves when the loop runs.
  async build(progress=()=>{}){
    const texture=this.loadTexture,nasa=this.nasa,terrain=this.terrain,container=this.container,canvas=this.canvas,onError=this.onError,t=this.t;
    const step=async k=>{progress(k);await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve)));return this.disposed;};
    this.makeEarth(texture);if(await step(.3))return;
    // The Moon: LROC colour and a normal map computed from the LOLA elevation model, both 4096 px, procedural craters
    // below their resolution and earthshine on the night side. Around the destination a cap is cut out and the finer
    // LOLA mesh takes its place.
    this.earthshine=earthshineUniforms();
    this.moonHole={dir:{value:new THREE.Vector3(0,-1,0)},cos:{value:Math.cos(140/RADIUS_KM)}};
    this.moon=mesh(new THREE.SphereGeometry(RADIUS_KM/1000,256,192),lunarMaterial({vertexColors:false,map:texture('moon-color.jpg',true,'error.moonTexture'),color:0xf2efe8,normalMap:texture('moon-normal.jpg',false),normalScale:1.25,normalY:1,hole:this.moonHole,space:globeSpace(),earthshine:this.earthshine,detail:DETAIL_GLOBE}),this.world);
    this.localEarth=mesh(new THREE.SphereGeometry(1,48,32),new THREE.MeshStandardMaterial({map:this.earthDay,roughness:.85}),this.local);
    this.vehicle=new Spacecraft(this.materials,nasa);setLayer(this.vehicle.group,1);this.world.add(this.vehicle.group);
    this.glints={lm:makeGlint(),csm:makeGlint()};for(const g of Object.values(this.glints)){setLayer(g,1);this.world.add(g);}
    this.spent={};for(const [kind] of SPENT){const g=new THREE.Group(),body=new THREE.Group();body.scale.setScalar(.001);body.add(buildSpent(this.materials,kind,nasa));g.add(body);g.visible=false;setLayer(g,1);this.world.add(g);this.spent[kind]=g;}
    this.localVehicle=new Spacecraft(this.materials,nasa);this.local.add(this.localVehicle.group);
    if(await step(.45))return;
    this.descentLeft=new THREE.Group();this.descentLeft.scale.setScalar(.001);this.descentLeft.add(buildDescentStage(this.materials,nasa));this.descentLeft.visible=false;this.local.add(this.descentLeft);
    // The Sun (camera-fx.js): its true disc, limb-darkened, drawn first so the bodies and the spacecraft cut it; the
    // camera adds the flare. The Milky Way (NASA SVS Deep Star Maps 2020) goes behind the scene in the camera pass.
    this.scene.add(this.fx.sun);this.fx.setMilkyWay(texture('milkyway.jpg',true));
    // What the spacecraft reflects in space: the scene itself, captured around it now and then.
    this.cubeTarget=new THREE.WebGLCubeRenderTarget(128,{type:THREE.HalfFloatType});this.cubeCamera=new THREE.CubeCamera(.00001,10000,this.cubeTarget);this.cubeCamera.children.forEach(c=>c.layers.set(0));
    this.pmrem=new THREE.PMREMGenerator(this.renderer);this.reflection=null;this.reflectionAge=1e9;this.sunOnVehicle=1;
    if(await step(.55))return;
    this.makeTerrain(terrain);if(await step(.8))return;
    this.makeOcean();
    this.pad=new LaunchPad(this.ocean.flatMaterial);this.pad.group.visible=false;this.scene.add(this.pad.group);
    this.padVehicle=new Spacecraft(this.materials);this.padVehicle.set('saturnV');this.pad.group.add(this.padVehicle.group);
    // NASA 8k imagery, swapped in after the 4k set is on screen: only where an 8k texture and memory to spare exist
    // (about +470 MiB of GPU memory), not on phones. The 4k set stays on any failure.
    this.whenReady.then(()=>{if(!this.disposed&&this.renderer.capabilities.maxTextureSize>=8192&&!(navigator.deviceMemory<8)&&matchMedia('(pointer:fine)').matches)this.load8k().then(maps=>this.use8k(maps)).catch(()=>{});});
    this.trail=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:.8}));this.world.add(this.trail);
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(container);this.resize();
    this.onContextLost=e=>{e.preventDefault();this.contextLost=true;if(!this.disposed)onError(t('error.contextLost'));};canvas.addEventListener('webglcontextlost',this.onContextLost);
    // Catalogue stars at their real brightness (Pogson, anchored on the Sun): they show only when the camera opens up.
    loadStarCatalog().then(data=>{if(!data||this.disposed)return;this.fx.setStars(data);this.dirty=true;});
    this.render=now=>{
      if(this.disposed)return;now=now??performance.now();this.animateCamera(now);
      const world=this.world.visible,pad=this.pad.group.visible;
      // Moving dust, waves, smoke and burning engines keep drawing while they are on screen.
      if(this.dustLevel>.02&&this.local.visible){this.landing.updateDust(this.dustLevel,now/1000);this.dirty=true;}
      if(this.oceanGroup.visible||pad)this.dirty=true; // waves, clouds and spray move every frame
      if(this.sample?.throttle>0&&(world||pad)){(pad?this.padVehicle:this.vehicle).engine(this.engineLevel??this.sample.throttle);this.dirty=true;}
      if(this.sample?.plasma>0&&world){this.vehicle.plasma(this.sample.plasma);this.dirty=true;}
      // The ground shakes the camera while the first stage burns close by.
      if(pad&&this.padTarget&&!this.manualCamera){const k=(this.engineLevel||0)*Math.max(0,1-this.sample.altitudeKm/1.2)*.0012,t=now/1000;this.controls.target.copy(this.padTarget).add(new THREE.Vector3(Math.sin(t*47)+Math.sin(t*83+1),Math.sin(t*59+2)+Math.sin(t*101),0).multiplyScalar(k));this.controls.update();}
      // The 8k textures go to the GPU one at a time (each upload stalls 120–400 ms on integrated GPUs): while paused,
      // or on a camera cut during playback, where the picture changes anyway.
      const upload=!this.playing||this.cut?this.uploads.shift():null;this.cut=false;if(upload){upload();this.dirty=true;}
      // The automatic exposure adapts on the GPU: keep drawing a few seconds after the last change so it settles.
      if(this.dirty)this.fx.touch(now);if(this.fx.settling(now))this.dirty=true;
      if(this.dirty&&!document.hidden&&!this.contextLost)this.frameNow(now);
      this.frame=requestAnimationFrame(this.render);
    };
    this.render();
  }
  // One picture of the current state, now (the render loop, and the warm-up before playback).
  frameNow(now=performance.now()){
    const camera=this.camera,world=this.world.visible;
    camera.updateMatrixWorld();this.sunView.value.copy(this.sunWorld).transformDirection(camera.matrixWorldInverse);
    if(world)this.earthRender.update(camera,ORIGIN,this.sunWorld,1000,this.moon.position);
    else if(this.sky.visible&&this.skySun){
      this.ocean.update(now,camera,this.skySun,{moonDirLocal:this.skyMoon,moonPhaseDeg:this.skyMoonPhase});
      this.oceanFog.color.copy(this.ocean.fogColor);this.oceanFog.far=this.ocean.fogFar;
      if(this.oceanGroup.visible){
        this.renderer.toneMappingExposure=this.ocean.exposure;
        // Afloat: the capsule heaves and rolls with the sea under it (model origin at the heat shield, ~0.6 m draft).
        if(this.sample&&this.sample.altitudeKm<.0005){const w=this.ocean.surfaceAt(0,0,this.surf),ov=this.oceanVehicle.group;ov.position.y=w.height-.0006;ov.quaternion.setFromUnitVectors(Y,w.normal).multiply(SPIN);}
      }
    }
    this.updateCameraFX();
    if(world&&++this.reflectionAge>40)this.captureReflection();
    this.film.uniforms.uTime.value=now/1000;this.composer.render();
    this.labels();this.dirty=false;
    // Ready once a few frames are on screen (the first ones compile the shaders of what is in view).
    if(++this.drawn===3)this.onReady();
  }
  // One frame into the current target. In space: the distant bodies first, then the spacecraft with its own
  // depth range, its own shadows and the sunlight it really gets (none inside the shadow of the Earth or the Moon).
  draw(){
    const r=this.renderer,camera=this.camera,sun=this.sunlight;camera.layers.set(0);
    if(!this.world.visible){camera.updateProjectionMatrix();r.render(this.scene,camera);return;}
    const at=this.vehicle.group.position,intensity=sun.intensity,position=sun.position.clone(),aim=sun.target.position.clone();
    camera.near=this.nearA;camera.far=10000;camera.updateProjectionMatrix();r.render(this.scene,camera);
    const d=camera.position.distanceTo(at),reach=Math.max(2e-5,this.vehicle.height*this.vehicle.group.scale.x*1.6),shadow=sun.shadow;
    const sunColor=sun.color.clone();if(this.sunTint)sun.color.multiply(this.sunTint);
    sun.intensity=intensity*this.sunOnVehicle;sun.target.position.copy(at);sun.position.copy(at).addScaledVector(this.sunWorld,reach*6);sun.target.updateMatrixWorld();
    Object.assign(shadow.camera,{left:-reach,right:reach,top:reach,bottom:-reach,near:reach,far:reach*12});shadow.camera.updateProjectionMatrix();shadow.normalBias=reach*.004;shadow.bias=-.0006;
    // The far plane also holds the other spacecraft of the rendezvous, up to the tens of kilometres it starts at.
    r.clearDepth();camera.layers.set(1);camera.near=Math.max(1e-9,d*.04);camera.far=Math.max(d*60+.002,this.vehicleFar||0);camera.updateProjectionMatrix();r.render(this.scene,camera);camera.layers.set(0);
    sun.intensity=intensity;sun.color.copy(sunColor);sun.position.copy(position);sun.target.position.copy(aim);shadow.normalBias=.00004;shadow.bias=-.00002;
  }
  // The Earth, the Moon, the Sun and the stars as the spacecraft sees them, filtered for reflections.
  captureReflection(){
    this.reflectionAge=0;const r=this.renderer,target=r.getRenderTarget();
    this.cubeCamera.position.copy(this.vehicle.group.position);this.cubeCamera.children.forEach(c=>{c.near=Math.max(1e-6,this.nearA);c.far=10000;c.updateProjectionMatrix();});
    // What lights the spacecraft stays physical. The Sun is already the directional light (reflecting its disc would
    // count it twice), and the exposure licences of the night side (city lights, moonlit ground, boosted earthshine,
    // the airglow when the spacecraft is in the shadow) are left out of its reflections.
    const U=this.earthRender.uniforms,night=U.uNightGain.value,moonE=U.uMoonE.value.clone(),air=this.earthRender.atmosphere.visible,shine=this.earthshine.intensity.value,sunShown=this.fx.sun.visible;
    U.uNightGain.value=0;U.uMoonE.value.setRGB(0,0,0);this.earthshine.intensity.value=shine/EARTHSHINE_BOOST;this.fx.sun.visible=false;
    if(this.sunTint&&Math.max(this.sunTint.r,this.sunTint.g,this.sunTint.b)<.05)this.earthRender.atmosphere.visible=false;
    // Each face is cleared first (the renderer runs with autoClear off for the two-pass draw).
    const autoClear=r.autoClear;r.autoClear=true;this.cubeCamera.update(r,this.scene);r.autoClear=autoClear;
    U.uNightGain.value=night;U.uMoonE.value.copy(moonE);this.earthshine.intensity.value=shine;this.earthRender.atmosphere.visible=air;this.fx.sun.visible=sunShown;
    this.reflection=this.pmrem.fromCubemap(this.cubeTarget.texture,this.reflection);r.setRenderTarget(target);
    if(this.envName==='space'||this.envName==='earth'||this.envName==='moon'){this.materials.setEnvironment(this.reflection.texture);this.envLive=true;}
  }
  makeEarth(texture){
    // Earth and atmosphere, physically based (earth-render.js): exact sphere, Hillaire 2020 sky, clouds, city lights.
    const day=this.earthDay=texture('earth-day.jpg',true,'error.earthTexture'),night=texture('earth-night.jpg',true),brc=texture('earth-brc.jpg',false);
    this.sunWorld=new THREE.Vector3(1,0,0);this.sunView={value:new THREE.Vector3(0,0,1)};
    this.earthRender=createEarthRenderer(this.renderer,{day,night,brc});
    this.earth=this.earthRender.earth;this.world.add(this.earth,this.earthRender.atmosphere);
  }
  makeTerrain(terrain){
    // Same LOLA relief as the explorer; around the destination, the landing site at lander scale. The local tiles, the
    // landing site and the patch share one Moon-fixed space, so their procedural craters are the globe's craters.
    this.regolith=regolithNormalMap(512,11,{craters:0});
    const lunar=siteSpace(siteBasis(terrain.site),RADIUS_KM+terrain.elevationKm-terrain.height(0,0)),opt=d=>({space:lunar,earthshine:this.earthshine,detail:d});
    this.landing=new LandingSite(terrain,{seed:[...terrain.site.id].reduce((s,c)=>s+c.charCodeAt(0),0),space:lunar,earthshine:this.earthshine});this.local.add(this.landing.group);
    const detail=mesh(detailedTerrainGeometry(terrain),lunarMaterial({normalMap:this.regolith,normalScale:.3,...opt(DETAIL_TILE)}),this.local);
    const innerGeometry=innerTerrainGeometry(terrain,{hole:this.landing.half}),inner=innerGeometry&&mesh(innerGeometry,lunarMaterial({normalMap:this.regolith,normalScale:.32,...opt(DETAIL_INNER)}),this.local);
    const context=contextTerrainGeometry(terrain);if(context)mesh(context,lunarMaterial({normalMap:null,...opt(DETAIL_CONTEXT)}),this.local);
    this.groundY=this.landing.heightAt(0,0);this.descentLeft.position.set(0,this.groundY,0);
    // The same relief seen from orbit and on the way down, set into the globe at the destination.
    this.patch=new THREE.Group();this.patch.matrixAutoUpdate=false;this.world.add(this.patch);
    const orbital=orbitalPatchGeometry(terrain);if(orbital){const m=new THREE.Mesh(orbital,lunarMaterial({normalMap:null,transparent:true,color:0xdedbd4,...opt(DETAIL_PATCH)}));this.patch.add(m);}
    for(const source of [detail,inner,this.landing.mesh])if(source)this.patch.add(new THREE.Mesh(source.geometry,source.material));
  }
  makeOcean(){
    // Pacific recovery area and the Atlantic at the pad (ocean.js): FFT sea to a curved horizon under the earth-render
    // sky, trade-wind cumulus, the capsule's splash. Needs this.earthRender (makeEarth runs first).
    const g=this.oceanGroup;g.visible=false;
    this.ocean=createOcean(this.renderer,{earth:this.earthRender});
    this.sky=this.ocean.sky;this.sky.visible=false;this.scene.add(this.sky);
    if(this.ocean.clouds){this.ocean.clouds.visible=false;this.scene.add(this.ocean.clouds);}
    this.water=this.ocean.water;g.add(this.ocean.group);
    this.oceanVehicle=new Spacecraft(this.materials,this.nasa);this.oceanVehicle.set('cmChutes');g.add(this.oceanVehicle.group);
    this.oceanFog=new THREE.Fog(0xb9cde0,0,100);this.surf={height:0,normal:new THREE.Vector3(0,1,0)};this.key={dir:new THREE.Vector3(),color:new THREE.Color(),intensity:0};
  }
  skyAt(site,date){
    // Real Sun over a point on Earth at that UTC time (day, twilight or night).
    const A=window.Astronomy,observer=new A.Observer(site.lat,site.lon,0);
    const eq=A.Equator(A.Body.Sun,date,observer,true,true),hor=A.Horizon(date,observer,eq.ra,eq.dec,'normal');
    const alt=hor.altitude*Math.PI/180,az=hor.azimuth*Math.PI/180,dir=new THREE.Vector3(Math.sin(az)*Math.cos(alt),Math.sin(alt),-Math.cos(az)*Math.cos(alt));
    const day=THREE.MathUtils.smoothstep(hor.altitude,-6,8);
    this.skySun=dir.clone();
    // The Moon over the same point (it lights the sea at night): direction and phase angle.
    const mq=A.Equator(A.Body.Moon,date,observer,true,true),mh=A.Horizon(date,observer,mq.ra,mq.dec,'normal'),ma=mh.altitude*Math.PI/180,mz=mh.azimuth*Math.PI/180;
    this.skyMoon=new THREE.Vector3(Math.sin(mz)*Math.cos(ma),Math.sin(ma),-Math.cos(mz)*Math.cos(ma));this.skyMoonPhase=A.Illumination(A.Body.Moon,date).phase_angle;
    return {dir,day,altitude:hor.altitude};
  }
  setPlan(plan){
    this.plan=plan;this.cameraKey='';this.cameraTween=null;this.lastLocal=undefined;this.lastScene=undefined;this.chaseD=0;
    const up=siteBasis(plan.site).up;this.moonHole.dir.value.set(up[0],up[2],-up[1]).normalize();
    for(const line of this.pathLines||[]){this.world.remove(line);line.geometry.dispose();line.material.dispose();}
    this.pathLines=[plan.outboundPath,plan.inboundPath].map((points,i)=>{const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map(space)),new THREE.LineBasicMaterial({color:i?0xd9d4ca:0xffffff,transparent:true,opacity:.62}));this.world.add(line);return line;});
    this.parkingLines=[plan.earthParking,plan.lunarParking,plan.lunarReturnParking].map((orbit,i)=>{
      const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(parkingPath(orbit).map(space)),new THREE.LineBasicMaterial({color:i===0?0xff5c9a:0xd9d4ca,transparent:true,opacity:.85}));
      this.world.add(line);this.pathLines.push(line);return line;
    });
    const orbit=Array.from({length:65},(_,i)=>space(moonPosition(new Date(plan.launch+(plan.returnAt-plan.launch)*i/64),window.Astronomy)));
    this.bounds=new THREE.Box3().setFromPoints([...plan.outboundPath.map(space),...plan.inboundPath.map(space),...orbit,new THREE.Vector3(-7,-7,-7),new THREE.Vector3(7,7,7)]).getBoundingSphere(new THREE.Sphere());
    const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(orbit),new THREE.LineDashedMaterial({color:0x77776f,dashSize:1,gapSize:1,transparent:true,opacity:.4}));line.computeLineDistances();this.world.add(line);this.pathLines.push(line);this.dirty=true;
  }
  setMode(mode){this.mode=mode;this.cameraKey='';if(this.sample)this.update(this.sample,this.conditions,true);}
  // Beside the spacecraft in the automatic camera? Coasts open and close that way; their middle is the whole trajectory.
  chasing(sample){return this.mode==='auto'&&(CHASE_PHASES.has(sample.phase)||(['outbound','inbound'].includes(sample.phase)&&(sample.t<.14||sample.t>.86)));}
  // Between the chase and the whole trajectory, the automatic camera looks out of the spacecraft window through a long
  // lens: first the body left behind, shrinking, then the destination, growing. Both at their true angular size.
  coastShot(sample){if(this.mode!=='auto'||!['outbound','inbound'].includes(sample.phase))return null;const t=sample.t;return t>=.14&&t<.42?'back':t>=.62&&t<.86?'ahead':null;}
  coastPose(sample,shot){
    const moon=(sample.phase==='outbound')===(shot==='ahead'),centre=moon?space(sample.moon):new THREE.Vector3(),radius=(moon?RADIUS_KM:EARTH_RADIUS)/1000;
    const at=space(sample.position),distance=at.distanceTo(centre),u=clamp(shot==='back'?(sample.t-.14)/.28:(sample.t-.62)/.24);
    // The lens is chosen for the share of the frame height the disc fills, so the change in size reads as motion.
    const fill=shot==='back'?.72-.4*u:.3+.42*u,fov=clamp(THREE.MathUtils.radToDeg(2*Math.asin(Math.min(1,radius/distance)))/fill,.8,60);
    return {position:at,target:centre,up:Y.clone(),fov,distance,body:moon?'Moon':'Earth'};
  }
  nearEarth(sample){return EARTH_PHASES.has(sample.phase)||sample.phase==='splashdown'||(sample.phase==='outbound'&&sample.t<.5)||(sample.phase==='inbound'&&sample.t>=.5);}
  update(sample,conditions,reset=false){
    const previous=this.sample;this.sample=sample;this.conditions=conditions;
    const overview=this.mode==='overview',ocean=sample.ocean&&!overview,pad=Boolean(sample.pad)&&!overview,local=sample.local&&!overview&&!ocean,world=!local&&!ocean&&!pad;
    const flight=world&&['descent','ascent'].includes(sample.phase),chase=world&&this.chasing(sample),earthSide=this.nearEarth(sample);
    const coast=world?this.coastShot(sample):null;this.coastNow=coast?this.coastPose(sample,coast):null;
    // Trajectory lines belong to the diagrams, not to the views beside or from the spacecraft.
    const lines=!(flight||chase||coast);
    this.world.visible=world;this.local.visible=local;this.oceanGroup.visible=ocean;this.pad.group.visible=pad;this.sky.visible=ocean||pad;if(this.ocean.clouds)this.ocean.clouds.visible=ocean||pad;
    this.scene.fog=ocean||pad?this.oceanFog:null;
    const sceneName=pad?'pad':ocean?'ocean':local?'local':'world';
    if(this.lastScene!==undefined&&sceneName!==this.lastScene&&(sceneName==='pad'||sceneName==='ocean'||this.lastScene==='pad'||this.lastScene==='ocean'))reset=true;
    const envName=ocean||pad?'ocean':LUNAR_PHASES.has(sample.phase)?'moon':EARTH_PHASES.has(sample.phase)?'earth':'space';
    if(envName!==this.envName||(!world&&this.envLive)){this.envName=envName;this.envLive=false;this.materials.setEnvironment(world&&this.reflection?this.reflection.texture:this.envs[envName].texture);this.envLive=world&&Boolean(this.reflection);if(world)this.reflectionAge=1e9;}
    this.moon.position.copy(space(sample.moon));
    this.parkingLines[1].position.copy(this.moon.position);this.parkingLines[2].position.copy(this.moon.position);
    for(const line of this.pathLines)line.visible=lines;
    this.parkingLines[1].visible=lines&&+sample.date<=this.plan.departure;this.parkingLines[2].visible=lines&&+sample.date>=this.plan.departure;
    const f=sample.frame,matrix=new THREE.Matrix4().makeBasis(v(f.x),v(f.z),v(f.y).negate());this.moon.quaternion.setFromRotationMatrix(matrix);
    // The LOLA mesh rides on the globe at the destination: local east, up and south become world axes.
    {
      const b=siteBasis(this.plan.site),up=toInertial(b.up,f),ground=RADIUS_KM+this.plan.elevationKm-this.terrain.height(0,0);
      this.patch.matrix.makeBasis(v(toInertial(b.east,f)),v(up),v(toInertial(b.north,f)).negate()).scale(new THREE.Vector3(.001,.001,.001)).setPosition(space(sample.moon.map((x,i)=>x+up[i]*ground)));this.patch.matrixWorldNeedsUpdate=true;
    }
    // Greenwich faces the sidereal angle (precession ignored: visual only).
    this.earth.rotation.y=window.Astronomy.SiderealTime(sample.date)*Math.PI/12;
    // Vehicle: the stage, module or capsule flying at this moment of the Apollo profile.
    this.vehicle.set(sample.config);this.engineLevel=sample.throttle||0;
    const attitude=v(sample.attitude||sample.direction).normalize(),holdCentre=earthSide?new THREE.Vector3():this.moon.position;
    this.vehicle.group.position.copy(space(sample.position));this.vehicle.group.visible=!coast;
    this.vehicle.group.quaternion.copy(holdAttitude(attitude,this.vehicle.group.position,holdCentre));
    // The lunar rendezvous: the ascent stage and the CSM each where the mission model puts them, with their own
    // attitudes (the vehicle frame stays unrotated; its origin is the point the picture follows).
    this.pairState=null;
    if(sample.config==='pair'&&sample.pair){
      const P=sample.pair,lm=space(P.lm),csm=space(P.csm),lmAtt=v(P.lmAttitude).normalize(),csmAtt=v(P.csmAttitude).normalize();
      this.pairState={lm,csm,lmAtt,csmAtt,lmQ:holdAttitude(lmAtt,lm,holdCentre),csmQ:holdAttitude(csmAtt,csm,holdCentre),gapKm:P.gapKm,rangeKm:P.rangeKm,status:P.status,rcs:P.rcs||0};
      this.vehicle.group.quaternion.identity();
    }
    const localTarget=sample.localPosition?new THREE.Vector3(...sample.localPosition):new THREE.Vector3(0,sample.altitudeKm,0);
    localTarget.y+=this.groundY;
    const lv=this.localVehicle;lv.set(sample.config==='ascent'?'ascent':'lm');lv.engine(local?sample.throttle||0:0,{altitudeKm:sample.altitudeKm,sunlit:conditions.sun.diskFraction>0,groundKm:sample.altitudeKm});
    lv.group.position.copy(localTarget);if(sample.config==='ascent')lv.group.position.y+=lv.ascentBase;
    if(sample.localDirection)lv.group.quaternion.setFromUnitVectors(Y,new THREE.Vector3(...sample.localDirection).normalize());
    this.descentLeft.visible=sample.phase==='ascent'||sample.phase==='lunarReturnOrbit';
    // Engine-blown regolith below ~30 m on landing, and when the ascent engine fires on the descent stage.
    this.dustLevel=!local?0:sample.phase==='descent'&&sample.engine?Math.max(0,1-sample.altitudeKm/.03)*(.4+.6*(sample.throttle||0)):sample.phase==='ascent'?Math.max(0,1-sample.altitudeKm/.012)*.5:0;
    if(this.dustLevel<=.02)this.landing.dust.visible=false;
    let sky=null;
    if(ocean){
      sky=this.skyAt(this.plan.entry.to,sample.date);const ov=this.oceanVehicle;ov.chutes(sample.chutes);
      ov.group.position.set(0,sample.altitudeKm,0);ov.group.rotation.set(0,.6,0);
      // Contact with the water: the splash once, then the white water the hull churns.
      const wet=sample.altitudeKm<=.0002;if(wet&&!this.splashed)this.ocean.splash(performance.now(),0,0);this.splashed=wet;
      this.ocean.setCraft(0,0,.00195,wet?.8:0,0);
    }
    if(pad){
      // Launch Complex 39A: the Saturn V at true size, held down while the engines build up, then climbing.
      sky=this.skyAt(APOLLO.launchSite,sample.date);
      const altitude=k=>APOLLO.liftoffAltitudeKm*Math.pow(clamp((k-.15)/.85),2.2),pv=this.padVehicle;
      pv.group.position.set(0,PAD_DECK+sample.altitudeKm+.45*pv.height,0);
      this.engineLevel=Math.min(1,sample.ignition*1.25);pv.engine(this.engineLevel,{altitudeKm:sample.altitudeKm,sunlit:sky.day>.3,groundKm:sample.altitudeKm+PAD_DECK});
      this.pad.update(sample.t,altitude,sample.ignition,sky.day,this.renderer.domElement.height/(2*Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2))));
    }
    // Light.
    const earthHelio=window.Astronomy.HelioVector(window.Astronomy.Body.Earth,sample.date);
    const sunWorld=v([earthHelio.x,earthHelio.y,earthHelio.z]).negate().normalize();this.sunWorld.copy(sunWorld);this.sunAU=Math.hypot(earthHelio.x,earthHelio.y,earthHelio.z);
    // Earthshine: the Earth's direction in the Moon's body axes and its irradiance from the Earth's phase (the angle
    // Sun–Earth–Moon at the Earth, the complement of the Moon's phase).
    {
      const d=this.moon.position.length(),inv=1/Math.max(d,1e-9);
      this.earthshine.direction.value.copy(this.moon.position).multiplyScalar(-inv).applyQuaternion(this.moon.quaternion.clone().invert());
      const phase=Math.acos(clamp(sunWorld.dot(this.moon.position.clone().multiplyScalar(inv)),-1,1));
      this.earthshine.intensity.value=earthshineIrradiance(phase,d*1000,local?1:EARTHSHINE_BOOST);
    }
    const sun=sky?sky.dir.clone():local?new THREE.Vector3(...conditions.sun.direction):sunWorld.clone();
    this.sunlight.color.set(0xfff6e4);this.sunlight.intensity=local?2.7*conditions.sun.diskFraction:3.2;
    this.fill.intensity=sky?.16+.3*sky.day:.03;this.fill.color.set(sky?0xbcd2ea:0xa4c2df);
    if(sky){
      // Key light of the sea scenes (ocean.js): the Sun through the air and any cloud in the way, the Moon at night.
      const k=this.ocean.keyLight(sky.dir,{moonDirLocal:this.skyMoon,moonPhaseDeg:this.skyMoonPhase,altitudeKm:ocean?Math.max(sample.altitudeKm,0)+.02:.06},this.key);
      this.sunlight.color.copy(k.color);this.sunlight.intensity=k.intensity;sun.copy(k.dir);
      // Fill: the sky's own irradiance (earth-render), never below the old night floor (readability).
      const e=this.earthRender.skyIrradiance(sky.dir.y),m=Math.max(e.r,e.g,e.b);if(m>1e-4)this.fill.color.setRGB(e.r/m,e.g/m,e.b/m);this.fill.intensity=Math.max(m,.16*(1-sky.day));
    }
    const anchor=ocean?this.oceanVehicle.group.position:pad?new THREE.Vector3(0,.06,0):local?localTarget:this.moon.position.clone().multiplyScalar(.5);
    this.sunlight.target.position.copy(anchor);this.sunlight.position.copy(anchor).add(sun.multiplyScalar(local?200:sky?40:1000));this.sunlight.castShadow=!ocean;
    const dark=local&&conditions.sun.diskFraction===0;this.earthlight.intensity=dark?.7:0;
    if(local){this.earthlight.target.position.copy(localTarget);this.earthlight.position.copy(localTarget).add(new THREE.Vector3(...conditions.earth.direction).multiplyScalar(200));}
    if(local||pad){const s=local?.45:.3;Object.assign(this.sunlight.shadow.camera,{left:-s,right:s,top:s,bottom:-s,near:.01,far:500});this.sunlight.shadow.camera.updateProjectionMatrix();}
    if(local){this.localEarth.position.copy(new THREE.Vector3(...conditions.earth.direction).multiplyScalar(350));this.localEarth.scale.setScalar(350*EARTH_RADIUS/conditions.earth.distanceKm);}
    // Regolith bounce onto downward faces: albedo × lunar-Lambert gain at grazing light × sin(elevation); 1.1 for the
    // local ground's albedo (~0.56).
    this.bounce.intensity=local?1.1*this.sunlight.intensity*Math.max(conditions.sun.direction[1],.03):0;
    this.sunOnVehicle=1;
    if(world){
      // Inside the shadow of the nearer body the spacecraft gets no sunlight at all (umbra; no penumbra model).
      {
        const centre=earthSide?new THREE.Vector3():this.moon.position,radius=(earthSide?EARTH_RADIUS:RADIUS_KM)/1000,rel=this.vehicle.group.position.clone().sub(centre),along=rel.dot(sunWorld);
        if(along<0){const off=rel.addScaledVector(sunWorld,-along).length();this.sunOnVehicle=THREE.MathUtils.smoothstep(off,radius*.995,radius*1.012);}
      }
      // Near the Earth the sunlight on the spacecraft comes through the air: red at orbital sunrise and sunset, then gone.
      if(earthSide){const p=this.vehicle.group.position,rr=p.length();this.sunTint=this.earthRender.sunTransmittance(rr*1000-EARTH_RADIUS,p.dot(sunWorld)/rr,this.sunTint||new THREE.Color());this.sunOnVehicle=1;}else this.sunTint=null;
      // Earthshine or moonshine from the lit ground below, strongest in low orbit over the day side.
      const centre=earthSide?new THREE.Vector3():this.moon.position,radius=(earthSide?EARTH_RADIUS:RADIUS_KM)/1000,out=this.vehicle.group.position.clone().sub(centre),distance=out.length();out.normalize();
      this.shine.color.set(earthSide?0x9cc0ff:0xcfc8bc);this.shine.intensity=(earthSide?1.5:.55)*Math.max(0,out.dot(sunWorld))*Math.pow(radius/distance,2);
      this.shine.target.position.copy(this.vehicle.group.position);this.shine.position.copy(this.vehicle.group.position).addScaledVector(out,-1);
      // Near the Moon, the Earth's light: its phase as seen from here, nothing when the Moon hides it.
      const at=this.vehicle.group.position,toEarth=at.clone().negate().normalize();
      this.earthshineLight.intensity=earthSide||this.rayHitsMoon(at,toEarth)?0:earthshineIrradiance(Math.acos(THREE.MathUtils.clamp(sunWorld.dot(at.clone().normalize()),-1,1)),at.length()*1000,EARTHSHINE_BOOST);
      this.earthshineLight.target.position.copy(at);this.earthshineLight.position.copy(at).add(toEarth);
    }else this.earthshineLight.intensity=0;
    // Exhaust and entry plasma, once the sunlight on the vehicle is known: altitude shapes the F-1 plume, fades the
    // entry glow below ~45 km and times the lunar-liftoff debris; groundKm clips the exhaust at the surface.
    const lit=this.sunOnVehicle*(world&&this.sunTint?Math.max(this.sunTint.r,this.sunTint.g,this.sunTint.b):1);
    this.vehicle.engine(pad?0:this.engineLevel,{altitudeKm:sample.altitudeKm,sunlit:lit>.5,groundKm:flight?sample.altitudeKm:null});
    this.vehicle.plasma(sample.plasma||0,{altitudeKm:sample.altitudeKm});
    this.renderer.toneMappingExposure=local?.92:1;
    // Camera.
    // A new stage beside the spacecraft is a new shot: the camera blends into its framing instead of jumping to it.
    const orbit=this.orbitForPhase(sample),key=pad?'pad':ocean?'ocean':local?'local':overview?'overview':this.mode==='follow'?'follow':coast?`coast-${coast}`:chase?`chase-${sample.phase}`:sample.phase;
    const padTarget=pad?new THREE.Vector3(0,PAD_DECK+sample.altitudeKm+.055,0):null;this.padTarget=padTarget;
    const target=pad?padTarget:ocean?this.oceanVehicle.group.position.clone().add(new THREE.Vector3(0,.021,0)):local?lv.group.position.clone().add(new THREE.Vector3(0,.004,0)):null;
    if(reset||key!==this.cameraKey){
      if(reset)this.chaseD=0;
      // The window shots start and end on a cut, like a film.
      const blend=!reset&&Boolean(this.cameraKey)&&!ocean&&!pad&&!coast&&!this.cameraKey.startsWith('coast'),from={position:this.camera.position.clone(),target:this.controls.target.clone(),up:this.camera.up.clone()};
      if(!blend){this.fx.resetAdaptation();this.cut=true;}
      if(blend&&!this.lastLocal&&this.lastPosition&&previous){const oldOrbit=this.orbitForPhase(previous),delta=oldOrbit&&this.lastFollow==='body'?(oldOrbit.body==='Moon'?space(sample.moon.map((x,i)=>x-previous.moon[i])):new THREE.Vector3()):space(sample.position.map((x,i)=>x-previous.position[i]));from.position.add(delta);from.target.add(delta);}
      if(blend&&local!==this.lastLocal){from.position=this.convertView(from.position,sample,local);from.target=this.convertView(from.target,sample,local);from.up=this.convertView(from.up,sample,local,true).normalize();}
      this.cameraKey=key;this.setCamera(sample,local,ocean,target,pad,chase,this.coastNow);
      this.manualCamera=false;this.cameraTween=null;
      if(blend){this.cameraTween={from,to:{position:this.camera.position.clone(),target:this.controls.target.clone(),up:this.camera.up.clone()},start:performance.now(),local,duration:1800};this.animateCamera(performance.now());}
    }
    else if(this.lastPosition){
      const follow=target||(overview||(['outbound','inbound'].includes(sample.phase)&&this.mode==='auto'&&!chase)?null:this.vehicle.group.position);
      if(follow){const delta=follow.clone().sub(this.lastPosition);if(!pad)this.camera.position.add(delta);this.controls.target.add(delta);if(this.cameraTween)for(const pose of [this.cameraTween.from,this.cameraTween.to]){pose.position.add(delta);pose.target.add(delta);}
        if(ocean&&this.camera.position.y<.003)this.camera.position.y=.003;this.controls.update();this.lastPosition=follow.clone();}
    }
    if(world&&this.mode==='auto'&&(flight||chase||coast)&&!this.manualCamera){
      const pose=coast?this.coastNow:this.autoPose(sample,flight);
      if(this.cameraTween)this.cameraTween.to=pose;
      else{this.camera.position.copy(pose.position);this.controls.target.copy(pose.target);this.camera.up.copy(pose.up);this.controls.update();}
    }
    // On the pad the camera stays on the ground and follows the rocket with a longer and longer lens.
    const fov=pad&&!this.manualCamera?clamp(THREE.MathUtils.radToDeg(2*Math.atan(.27/this.camera.position.distanceTo(padTarget))),6,45):coast?this.coastNow.fov:45;
    if(Math.abs(this.camera.fov-fov)>.01)this.camera.fov=fov;
    this.lastLocal=local;this.lastScene=sceneName;this.closeView=flight||chase||Boolean(coast);
    this.trail.geometry.dispose();let points=sample.phase==='outbound'?this.plan.outboundPath.slice(0,Math.max(2,Math.ceil(sample.t*200))):sample.phase==='inbound'?this.plan.inboundPath.slice(0,Math.max(2,Math.ceil(sample.t*200))):[];
    if(sample.orbit){
      const orbit=sample.orbit,span=sample.orbitAt-sample.orbitFrom,count=Math.max(2,Math.min(600,Math.ceil(192*span/(orbit.periodSeconds*1000))));
      points=Array.from({length:count},(_,i)=>{const relative=parkingState(orbit,sample.orbitFrom+span*i/(count-1)).relative;return orbit.body==='Earth'?relative:relative.map((x,k)=>x+sample.moon[k]);});
    }
    this.trail.geometry=new THREE.BufferGeometry().setFromPoints(points.map(space));this.trail.visible=lines&&points.length>1;
    // Beside the spacecraft everything is true size; in the wide views the vehicle is enlarged to stay visible.
    const close=this.mode==='follow',ref=this.vehicle.height,trueSize=flight||chase||Boolean(this.cameraTween);
    const size=this.camera.position.distanceTo(this.vehicle.group.position)*(close?.055:.022)/ref,scale=Math.max(trueSize?.001:4*.014/ref,trueSize?0:size);this.vehicle.group.scale.setScalar(scale);
    this.updatePair(scale,trueSize);
    // Spent stages fall behind, slowly tumbling.
    for(const [kind,phase,from,to,gap,drift] of SPENT){
      const g=this.spent[kind],on=world&&!coast&&sample.phase===phase&&sample.t>=from&&sample.t<=to;g.visible=on;if(!on)continue;
      const k=(sample.t-from)/(to-from),away=(gap+drift*k)*1e-6*(scale/.001);
      g.position.copy(this.vehicle.group.position).addScaledVector(attitude,-away);g.scale.setScalar(scale);
      g.quaternion.copy(this.vehicle.group.quaternion).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(k*.9,k*.35,0)));
    }
    this.dirty=true;
    const height=Math.max(0,sample.altitudeKm)*.001;
    this.nearA=flight||chase?clamp(height*.25,1e-5,.02):coast?Math.max(.01,this.coastNow.distance*.02):Math.max(1e-8,Math.min(.0005,this.camera.position.distanceTo(this.controls.target)*.02));
    this.camera.near=local||ocean||pad?.0001:this.nearA;this.camera.far=ocean||pad?200:10000;this.camera.updateProjectionMatrix();
    const night=sky&&sky.day<.15,lights=this.pairState&&(flight||chase)&&this.sunOnVehicle<.5;
    document.getElementById('missionScale').textContent=(pad?this.t('msc.pad'):ocean?this.t('msc.ocean'):local?this.t(sample.config==='ascent'?'msc.localAscent':'msc.local'):flight?this.t(sample.phase==='ascent'?'msc.climb':'msc.approach'):coast?this.t(`msc.${coast}${this.coastNow.body}`):chase?this.t(this.pairState?.status==='rendezvous'?'msc.rendezvous':earthSide?'msc.chaseEarth':'msc.chaseMoon'):sample.orbit?this.t('msc.orbit'):this.t('msc.space'))+(lights?` · ${this.t('msc.lights')}`:'')+(dark?` · ${this.t('light.reading')}`:'')+(night?` · ${this.t('msc.night')}`:'');
  }
  // The pair's bodies in the vehicle frame and, when one is too far to resolve, its point of light: sunlit metal
  // (brighter as the range closes, by the inverse square) or, on the night side, only its flashing light.
  updatePair(scale,trueSize){
    const S=this.pairState,glints=this.glints;
    if(!S){glints.lm.visible=glints.csm.visible=false;this.vehicleFar=0;return;}
    // Offsets in true metres (scene units are 1000 km): when the wide views enlarge the vehicle, the pair grows as one.
    const origin=this.vehicle.group.position,toBody=1e6,cam=this.camera.position,pxPerRad=this.container.clientHeight/THREE.MathUtils.degToRad(this.camera.fov);
    const px=(p,metres)=>metres*1e-6/Math.max(p.distanceTo(cam),1e-12)*pxPerRad;
    const lmPx=px(S.lm,4.5),csmPx=px(S.csm,11),close=S.lm.distanceTo(S.csm)<5e-5,lit=this.sunOnVehicle,time=performance.now()/1000;
    this.vehicle.pair({lm:S.lm.clone().sub(origin).multiplyScalar(toBody),csm:S.csm.clone().sub(origin).multiplyScalar(toBody),lmQ:S.lmQ,csmQ:S.csmQ,
      showLm:trueSize?lmPx>1:true,showCsm:trueSize?csmPx>1:close,time,sunlit:lit,rcs:S.rcs});
    const flash=phase=>{const f=(((time+phase)%1)+1)%1;return f<.12?Math.exp(-f*30):0;},earth=this.earthshineLight.intensity/3.2;
    for(const [name,p,size,phase,reach] of [['csm',S.csm,csmPx,.47,60],['lm',S.lm,lmPx,0,25]]){
      const g=glints[name],km=Math.max(p.distanceTo(cam)*1000,1e-6),fade=1-ramp(2,7,size),near=Math.min(1,(reach/km)**2);
      const level=trueSize?fade*((lit+(1-lit)*earth)*near+(1-lit)*flash(phase)*Math.min(1,(reach*.5/km)**2)):0;
      g.visible=level>.002&&!this.behindMoon(p);if(g.visible){g.position.copy(p);g.material.color.setScalar(6*level);}
    }
    this.vehicleFar=trueSize?Math.max(S.lm.distanceTo(cam),S.csm.distanceTo(cam))*1.3:0;
  }
  // Is a point hidden from the camera by the Moon's disc?
  behindMoon(p){
    const c=this.camera.position,d=p.clone().sub(c),L=d.length();d.divideScalar(L||1);
    const m=this.moon.position.clone().sub(c),tc=m.dot(d),r=RADIUS_KM/1000;
    return tc>0&&tc<L&&m.lengthSq()-tc*tc<r*r;
  }
  // Does the ray from a point along a unit direction meet the Moon?
  rayHitsMoon(from,dir){const m=this.moon.position.clone().sub(from),tc=m.dot(dir),r=RADIUS_KM/1000;return tc>0&&m.lengthSq()-tc*tc<r*r;}
  orbitForPhase(sample){
    if(['earthOrbit','tli'].includes(sample.phase))return this.plan.earthParking;
    if(['loi','lunarOrbit'].includes(sample.phase))return this.plan.lunarParking;
    if(['lunarReturnOrbit','tei'].includes(sample.phase))return this.plan.lunarReturnParking;
    return null;
  }
  convertView(point,sample,toLocal,direction=false){
    const basis=siteBasis(this.plan.site),ground=RADIUS_KM+this.plan.elevationKm-this.terrain.height(0,0);
    if(toLocal){
      const inertial=[point.x,-point.z,point.y].map(x=>x*(direction?1:1000));
      const body=sample.frame.transform(direction?inertial:inertial.map((x,i)=>x-sample.moon[i]));
      const dot=a=>body.reduce((sum,x,i)=>sum+x*a[i],0);
      return new THREE.Vector3(dot(basis.east),dot(basis.up)-(direction?0:ground),-dot(basis.north));
    }
    const body=basis.east.map((x,i)=>x*point.x+basis.up[i]*(point.y+(direction?0:ground))-basis.north[i]*point.z);
    const inertial=toInertial(body,sample.frame);return direction?v(inertial):space(inertial.map((x,i)=>x+sample.moon[i]));
  }
  flightCameraPose(sample){
    const view=(this.conditions?sideLitView(this.conditions.sun.direction):LOCAL_VIEW).clone();
    // High up, the camera rises above the lander and looks down, so the ground fills the background; the distance
    // stays short enough for a 7 m lander to read.
    const across=Math.hypot(view.x,view.z),elevation=THREE.MathUtils.degToRad(9.4+Math.min(30,sample.altitudeKm*3));view.y=across*Math.tan(elevation);
    // (The 3.8 m ascent stage is filmed closer than the 7 m lander coming down.)
    const reach=sample.phase==='ascent'?.03+Math.min(.015,sample.altitudeKm*.002):.04+Math.min(.04,sample.altitudeKm*.004);
    const target=this.vehicle.group.position.clone(),offset=this.convertView(view,sample,false,true).normalize().multiplyScalar(reach/1000);
    return {position:target.clone().add(offset),target,up:this.convertView(Y,sample,false,true).normalize()};
  }
  // The automatic camera beside the spacecraft. On the climb from the Moon it swings from above the ascent stage (the
  // ground filling the background) to over its shoulder, toward the CSM, by ~40 km up; the rendezvous has its own shots.
  autoPose(sample,flight){
    if(flight)return this.pairState?orbitBlend(this.flightCameraPose(sample),this.pairPose(sample),ramp(6,40,sample.altitudeKm)):this.flightCameraPose(sample);
    return this.pairState?this.pairPose(sample):this.chasePose(sample);
  }
  // The rendezvous, filmed round a pivot. While the CSM is far: the pivot 20 m ahead of the ascent stage and the camera
  // over its shoulder, the view splitting the angle between the CSM above and the horizon below, so the CSM (a point,
  // then a shape) grows ahead with the Moon in frame. From ~120 m to ~25 m the camera swings out beside the pair, the
  // pivot between them, far enough to hold both for the contact; then it circles the docked stack slowly, follows the
  // CSM after the jettison and eases into the ordinary chase framing the injection burn continues with. Up is the local
  // vertical, so the horizon stays level.
  pairPose(sample){
    const S=this.pairState,M=1e-6,up=this.vehicle.group.position.clone().sub(this.moon.position),r=up.length();up.normalize();
    const lmC=S.lm.clone().addScaledVector(S.lmAtt,1.4*M),los=S.csm.clone().sub(lmC).normalize();
    const motion=v(sample.direction).normalize(),along=los.clone().addScaledVector(up,-los.dot(up));
    if(along.lengthSq()<1e-6)along.copy(motion).addScaledVector(up,-motion.dot(up));along.normalize();
    const side=new THREE.Vector3().crossVectors(along,up).normalize();
    const R=RENDEZVOUS,t=sample.t,orbiting=sample.phase==='lunarReturnOrbit',docked=orbiting&&t>=R.contact,gap=docked?0:Math.max(S.gapKm*1000,0);
    const k=docked?1:ramp(-Math.log(120),-Math.log(25),-Math.log(Math.max(gap,.01)));
    const elevation=Math.asin(THREE.MathUtils.clamp(los.dot(up),-1,1)),dip=Math.acos(THREE.MathUtils.clamp(RADIUS_KM/1000/r,-1,1));
    const tilt=THREE.MathUtils.clamp((elevation-dip)/2,-.5,.5),ahead=along.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(up,Math.sin(tilt));
    // Far: the camera 23 m behind the ascent stage, 7.4 m to the side and 4.6 m up, looking straight along `ahead` (so
    // the stage sits low and to one side of the frame, the CSM above the centre, the horizon below it).
    const far=lmC.clone().addScaledVector(ahead,20*M).addScaledVector(side,7.4*M).addScaledVector(up,4.6*M);
    const pivot=far.lerp(lmC.clone().addScaledVector(los,Math.min(gap+7.5,40)/2*M),k);
    if(orbiting)pivot.lerp(S.csm,ramp(R.jettison,R.separated+.06,t));
    const beside=side.clone().addScaledVector(up,.3).addScaledVector(along,-.2).normalize().applyAxisAngle(up,docked?.9*(t-R.contact):0);
    const distance=Math.exp(THREE.MathUtils.lerp(Math.log(43),Math.log(THREE.MathUtils.clamp(1.3*(gap+16),24,70)),k))*M;
    let pose={position:pivot.clone().addScaledVector(slerpDir(ahead.clone().negate(),beside,k),distance),target:pivot,up};
    if(orbiting&&t>R.turned)pose=orbitBlend(pose,this.chasePose(sample),ramp(R.turned,.97,t));
    return pose;
  }
  // Beside and a little above the spacecraft, the horizon of the nearer body level behind it; drifts slowly around.
  chasePose(sample){
    const at=this.vehicle.group.position.clone(),centre=this.nearEarth(sample)?new THREE.Vector3():this.moon.position;
    const radial=at.clone().sub(centre).normalize(),motion=v(sample.direction).normalize();
    const side=new THREE.Vector3().crossVectors(motion,radial);if(side.lengthSq()<1e-4)side.crossVectors(radial,Math.abs(radial.y)<.9?Y:new THREE.Vector3(1,0,0));side.normalize();
    const forward=new THREE.Vector3().crossVectors(radial,side).normalize(),wanted=Math.max(.022,this.vehicle.height*3.1);
    this.chaseD=this.chaseD?this.chaseD+(wanted-this.chaseD)*.14:wanted;
    const entry=sample.phase==='arrival',swing=(sample.t-.5)*(entry?.5:1.1);
    const offset=forward.multiplyScalar(entry?-.2:-.5).addScaledVector(side,entry?1:.85).addScaledVector(radial,entry?.22:.3).normalize().applyAxisAngle(radial,swing).multiplyScalar(this.chaseD*.001);
    return {position:at.clone().add(offset),target:at,up:radial};
  }
  animateCamera(now){
    const tween=this.cameraTween;if(!tween)return;
    const t=THREE.MathUtils.clamp((now-tween.start)/tween.duration,0,1),u=t*t*(3-2*t),{from,to}=tween;
    const a=from.position.clone().sub(from.target),b=to.position.clone().sub(to.target),distance=Math.exp(THREE.MathUtils.lerp(Math.log(Math.max(a.length(),1e-8)),Math.log(Math.max(b.length(),1e-8)),u));
    const turn=new THREE.Quaternion().setFromUnitVectors(a.clone().normalize(),b.clone().normalize());
    const offset=a.normalize().applyQuaternion(new THREE.Quaternion().slerp(turn,u)).multiplyScalar(distance);
    this.controls.target.copy(from.target).lerp(to.target,u);this.camera.position.copy(this.controls.target).add(offset);this.camera.up.copy(from.up).lerp(to.up,u).normalize();
    if(!tween.local){
      // Keep a blended camera outside both globes while zooming from the surface.
      for(const [center,radius] of [[new THREE.Vector3(),EARTH_RADIUS/1000],[this.moon.position,RADIUS_KM/1000]]){const relative=this.camera.position.clone().sub(center);if(relative.length()<radius+.000001)this.camera.position.copy(center).add(relative.setLength(radius+.000001));}
    }
    this.controls.maxDistance=Math.max(tween.local?40:1500,distance*1.1);this.camera.near=tween.local?.0001:Math.max(1e-8,Math.min(.0005,distance*.02));this.camera.updateProjectionMatrix();this.controls.update();this.dirty=true;
    if(t===1)this.cameraTween=null;
  }
  setCamera(sample,local,ocean=false,target=null,pad=false,chase=false,coast=null){
    const ground=local||ocean||pad,flight=['descent','ascent'].includes(sample.phase);
    this.camera.up.copy(Y);this.camera.near=ground?.0001:.0005;this.camera.far=ocean||pad?200:10000;this.camera.updateProjectionMatrix();this.controls.minDistance=ground?.012:flight||chase?.000008:.02;this.controls.maxDistance=local?40:ocean||pad?20:1500;this.controls.enablePan=true;this.controls.maxPolarAngle=ground?Math.PI*.49:Math.PI-.01;
    if(pad){const at=target||new THREE.Vector3(0,PAD_DECK+.055,0);this.controls.target.copy(at);this.camera.position.copy(PAD_CAMERA);this.lastPosition=at.clone();}
    else if(ocean){const at=target||new THREE.Vector3();this.controls.target.copy(at);this.camera.position.copy(at).add(new THREE.Vector3(.064,-.007,.09));this.camera.position.y=Math.max(.003,this.camera.position.y);this.lastPosition=at.clone();}
    else if(local){const at=target||this.localVehicle.group.position.clone().add(new THREE.Vector3(0,.004,0));this.controls.target.copy(at);this.camera.position.copy(at).add(this.conditions?sideLitView(this.conditions.sun.direction):LOCAL_VIEW);this.lastPosition=at.clone();}
    else if(this.mode==='auto'&&coast){this.camera.position.copy(coast.position);this.controls.target.copy(coast.target);this.camera.up.copy(coast.up);this.lastPosition=null;}
    else if(this.mode==='auto'&&chase){
      this.chaseD=0;const pose=this.autoPose(sample,false);this.camera.position.copy(pose.position);this.controls.target.copy(pose.target);this.camera.up.copy(pose.up);this.lastPosition=this.vehicle.group.position.clone();
    }
    else if(this.mode==='overview'||['outbound','inbound'].includes(sample.phase)&&this.mode==='auto'){
      const center=this.bounds.center,distance=this.bounds.radius/Math.sin(THREE.MathUtils.degToRad(this.camera.fov/2))*1.12/Math.min(this.camera.aspect,1),axis=space(this.plan.outboundCurve[3]).normalize();
      const offset=new THREE.Vector3().crossVectors(axis,Y);if(offset.length()<.1)offset.set(0,0,1);offset.normalize().add(new THREE.Vector3(0,.6,0)).normalize();
      this.controls.target.copy(center);this.camera.position.copy(center).add(offset.multiplyScalar(distance));this.lastPosition=null;
    }else if(this.mode==='auto'&&flight){
      const pose=this.autoPose(sample,true);this.camera.position.copy(pose.position);this.controls.target.copy(pose.target);this.camera.up.copy(pose.up);this.lastPosition=this.vehicle.group.position.clone();
    }else{
      const at=this.vehicle.group.position.clone(),up=v(sample.direction).normalize(),side=new THREE.Vector3().crossVectors(up,Y);if(side.length()<.01)side.set(1,0,0);side.normalize();const distance=12;
      this.controls.target.copy(at);this.camera.position.copy(at).add(up.clone().multiplyScalar(distance*.45)).add(side.multiplyScalar(distance));this.lastPosition=at.clone();
    }
    this.controls.update();this.dirty=true;
  }
  // The camera: Sun and occluders for the flare, sky orientation, fixed exposure on the pad and the ocean.
  updateCameraFX(){
    const fx=this.fx,world=this.world.visible,local=this.local.visible&&this.conditions&&this.sample;
    fx.sun.visible=world||Boolean(local);fx.setFixedExposure(this.pad.group.visible||this.oceanGroup.visible?1:null);
    const diagram=world&&!this.closeView,lunarNight=world&&this.closeView&&this.sample&&!this.nearEarth(this.sample)&&this.sunOnVehicle<.5;
    // Close views keep the stars an eye sees (EYE_STARS, camera-fx.js); the diagrams their long exposure.
    fx.params.stars=diagram?DIAGRAM_STARS:EYE_STARS.stars;fx.params.starAdapt=diagram?1:EYE_STARS.starAdapt;fx.params.milkyWay=diagram?DIAGRAM_MILKY_WAY:1;fx.params.maxEV=diagram?20:lunarNight?LUNAR_NIGHT_EV:CLOSE_MAX_EV;
    if(local){
      const b=siteBasis(this.plan.site),f=this.sample.frame;
      fx.setSkyRows(toInertial(b.east,f),toInertial(b.up,f),toInertial(b.north,f).map(x=>-x));
      fx.update(this.camera,{sunDir:new THREE.Vector3(...this.conditions.sun.direction),distanceAU:this.sunAU});
    }else{
      const earth={centre:ORIGIN,radius:EARTH_RADIUS/1000};
      fx.setSkyRows([1,0,0],[0,0,1],[0,-1,0]);
      fx.update(this.camera,{sunDir:this.sunWorld,spheres:[earth,{centre:this.moon.position,radius:RADIUS_KM/1000}],earth,distanceAU:this.sunAU});
    }
  }
  // NASA 8k imagery (scripts/prepare-mission-assets.mjs). createImageBitmap decodes off the main thread, each map goes
  // up in a frame of its own, and the Earth shader's 8k variant compiles in parallel beforehand, so nothing stalls.
  load8k(){
    const bitmaps=new THREE.ImageBitmapLoader().setOptions({imageOrientation:'flipY',premultiplyAlpha:'none',colorSpaceConversion:'none'});
    // The Earth's maps get the anisotropy earth-render's setMaps gives them (8), so swapping them in changes nothing that
    // would send them to the GPU a second time.
    const r=this.renderer,max=r.capabilities.getMaxAnisotropy();
    const load=(file,srgb,single,anisotropy=Math.min(8,max))=>new Promise((ok,ko)=>bitmaps.load(asset(`./assets/mission/${file}`),bitmap=>{
      const t=new THREE.Texture(bitmap);t.flipY=false;t.colorSpace=srgb?THREE.SRGBColorSpace:THREE.NoColorSpace;t.anisotropy=anisotropy;t.wrapS=THREE.RepeatWrapping;
      if(single)t.format=THREE.RedFormat; // R8: a quarter of the memory and of the upload time; the shader reads .r
      t.needsUpdate=true;this.uploads.push(()=>{if(this.disposed){t.dispose();return;}r.initTexture(t);ok(t);});
    },undefined,ko));
    return Promise.all([load('earth-day-8k.jpg',true),load('earth-night-8k.jpg',true),load('earth-clouds-8k.jpg',false,true),load('earth-water-8k.png',false,true),load('moon-color-8k.jpg',true,false,max),this.warmEarth8k()]);
  }
  // The Earth shader with the cloud and water maps, compiled ahead (in parallel where the browser offers it) into the
  // target the bodies are drawn to: tone mapping and output colour space are part of the program.
  warmEarth8k(){
    const m=this.earth.material,r=this.renderer,target=r.getRenderTarget();
    this.earthWarm=new THREE.ShaderMaterial({uniforms:m.uniforms,vertexShader:m.vertexShader,fragmentShader:m.fragmentShader,defines:{...m.defines,CLOUD_MAP:'',WATER_MAP:''}});
    let done;r.setRenderTarget(this.fx.stage);
    try{done=r.compileAsync(new THREE.Mesh(this.earth.geometry,this.earthWarm),this.camera,this.scene);}catch{done=Promise.resolve();}finally{r.setRenderTarget(target);}
    return done.catch(()=>{});
  }
  use8k([day,night,clouds,water,moon]){
    if(this.disposed){for(const t of [day,night,clouds,water,moon])t.dispose();return;}
    const U=this.earthRender.uniforms,old=[U.uDay.value,U.uNight.value,this.moon.material.map];
    this.earthRender.setMaps({day,night,clouds,water,dayStyle:'bmng'});
    this.moon.material.map=moon;this.localEarth.material.map=day;
    for(const t of old)t.dispose(); // earth-brc.jpg stays: relief (R)
    this.textures.push(day,night,clouds,water,moon);this.dirty=true;
  }
  labels(){
    for(const [name,body] of [['Earth',this.earth],['Moon',this.moon]]){
      const label=document.getElementById(`mission${name}Label`),p=body.position.clone().project(this.camera),visible=this.world.visible&&!this.closeView&&p.z<1&&p.z>-1&&Math.abs(p.x)<.97&&Math.abs(p.y)<.92;
      label.style.display=visible?'block':'none';label.style.transform=`translate(${(p.x*.5+.5)*this.container.clientWidth+10}px,${(-p.y*.5+.5)*this.container.clientHeight}px)`;
    }
  }
  resize(){const {width,height}=this.container.getBoundingClientRect();if(!width||!height)return;this.renderer.setSize(width,height,false);this.composer.setSize(width,height);this.camera.aspect=width/height;this.camera.updateProjectionMatrix();this.cameraKey='';if(this.sample)this.update(this.sample,this.conditions,true);this.dirty=true;}
  dispose(){
    if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.frame);this.resizeObserver?.disconnect();this.canvas.removeEventListener('webglcontextlost',this.onContextLost);this.controls.dispose();
    this.scene.traverse(object=>{object.geometry?.dispose();if(object.material){for(const mat of Array.isArray(object.material)?object.material:[object.material]){mat.map?.dispose?.();mat.dispose();}}});
    this.materials.dispose();for(const env of Object.values(this.envs))env.dispose();this.cubeTarget?.dispose();this.reflection?.dispose();this.pmrem?.dispose();this.composer.dispose();this.landing?.dispose();this.ocean?.dispose();this.earthRender?.dispose();this.fx.dispose();this.earthWarm?.dispose();
    this.textures.forEach(tex=>tex.dispose());this.regolith?.dispose();this.renderer.dispose();this.renderer.forceContextLoss();
  }
}
