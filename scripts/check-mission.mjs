import assert from 'node:assert/strict';
import * as Astronomy from 'astronomy-engine';
import { sites } from '../dist/sites.js';
import { PHASES,ANIMATION_SECONDS,presentationTime,HOUR,EARTH_RADIUS,PARKING,APOLLO,RENDEZVOUS,DOCKED_KM,buildMission,sampleMission,lunarPoint,geoPoint,parkingState } from '../dist/mission-model.js';
import { RADIUS_KM } from '../dist/model.js';
import * as THREE from 'three';
import { MissionScene } from '../dist/mission-scene.js';
const magnitude=v=>Math.hypot(...v),difference=(a,b)=>a.map((v,i)=>v-b[i]);
const progressAt=(id,t=0)=>{const p=PHASES.find(p=>p.id===id);return p.start+(p.end-p.start)*t;};
const plan=buildMission({site:sites[0],windowStart:'2026-10-22T18:00:00Z',windowEnd:'2026-10-29T00:00:00Z',outboundHours:72,stayHours:24,inboundHours:72},Astronomy);
assert.equal(new Date(plan.launch).toISOString(),'2026-10-19T18:00:00.000Z');
assert.equal(plan.returnAt,Date.parse('2026-10-26T18:00:00.000Z')+plan.returnShiftHours*HOUR,'Return = nominal + daylight shift');
assert.ok(Math.abs(plan.returnShiftHours)<=10);
let previous=-Infinity;
for(let i=0;i<=1000;i++){
  const s=sampleMission(plan,i/1000,Astronomy);assert.ok(+s.date>=previous);previous=+s.date;
  assert.ok(s.position.every(Number.isFinite));assert.ok(s.direction.every(Number.isFinite));assert.ok(s.altitudeKm>=0);assert.ok(s.distanceKm>320000&&s.distanceKm<420000);
}
for(const phase of PHASES.slice(1)){
  const left=sampleMission(plan,phase.start-1e-9,Astronomy),right=sampleMission(plan,phase.start,Astronomy);
  assert.ok(Math.hypot(...left.position.map((v,i)=>v-right.position[i]))<.1,`Position discontinuity: ${phase.id}`);
  assert.ok(Math.abs(+left.date-+right.date)<100,`Clock discontinuity: ${phase.id}`);
  assert.ok(left.direction.reduce((sum,x,i)=>sum+x*right.direction[i],0)>.999,`Attitude discontinuity: ${phase.id}`);
}
const landed=sampleMission(plan,progressAt('surface'),Astronomy),returned=sampleMission(plan,1,Astronomy);
assert.equal(+landed.date,plan.arrival);assert.equal(landed.altitudeKm,0);assert.equal(landed.phase,'surface');
assert.deepEqual(landed.position,lunarPoint(plan.site,landed.date,Astronomy));
assert.equal(+returned.date,plan.returnAt);assert.equal(returned.altitudeKm,0);assert.deepEqual(returned.position,geoPoint(plan.entry.to.lat,plan.entry.to.lon,returned.date,Astronomy));
assert.ok(plan.entry.to.lon>=150||plan.entry.to.lon<=-120,'Splashdown in the Pacific recovery band');
assert.equal(returned.phase,'splashdown');assert.equal(returned.config,'cmChutes');
// Apollo profile: S-IVB to orbit, CSM+LM out, LM down, ascent stage up, CSM back, CM alone at entry.
for(const [id,t,config] of [['liftoff',.5,'saturnV'],['launch',.1,'saturnV'],['launch',.5,'stage2'],['earthOrbit',.5,'sivb'],['outbound',.5,'stack'],['descent',.5,'lm'],['ascent',.5,'ascent'],['inbound',.5,'csm'],['arrival',.5,'cm']])assert.equal(sampleMission(plan,progressAt(id,t),Astronomy).config,config,`${id} config`);
const entry=sampleMission(plan,progressAt('arrival',0),Astronomy);assert.ok(Math.abs(entry.altitudeKm-APOLLO.entryAltitudeKm)<.01,'Entry interface at 121.9 km');
assert.ok(sampleMission(plan,progressAt('arrival',.5),Astronomy).plasma>.5,'Plasma sheath during entry');
assert.throws(()=>buildMission({...plan,stayHours:151},Astronomy),/caber/);
assert.throws(()=>buildMission({...plan,outboundHours:0},Astronomy),/24 a 240/);
assert.equal(plan.departure-plan.arrival,24*HOUR);
assert.equal(plan.times.earthOrbit[1],plan.times.tli[0]);
assert.equal(plan.times.lunarOrbit[1],plan.times.descent[0]);
assert.equal(plan.times.ascent[1],plan.times.lunarReturnOrbit[0]);
assert.equal(plan.times.lunarReturnOrbit[1],plan.times.tei[0]);
assert.ok(plan.earthParking.periodSeconds/60>88&&plan.earthParking.periodSeconds/60<89,'185 km Earth parking orbit: ~88 min');
assert.ok(plan.lunarParking.periodSeconds/60>118&&plan.lunarParking.periodSeconds/60<120,'110 km lunar orbit: ~119 min');
for(const [id,orbit] of [['earthOrbit',plan.earthParking],['lunarOrbit',plan.lunarParking],['lunarReturnOrbit',plan.lunarReturnParking]]){
  assert.ok(Math.abs((orbit.end-orbit.start)/1000-orbit.turns*orbit.periodSeconds)<1e-6);
  const first=parkingState(orbit,orbit.start),full=parkingState(orbit,orbit.start+orbit.periodSeconds*1000);
  assert.ok(magnitude(difference(first.relative,full.relative))<1e-5,'Circular orbit must close after its Kepler period');
  for(let i=0;i<=100;i++){
    const ms=orbit.start+(orbit.end-orbit.start)*i/100,state=parkingState(orbit,ms);
    assert.ok(Math.abs(magnitude(state.relative)-orbit.radiusKm)<1e-8);
    assert.ok(Math.abs(state.relative.reduce((sum,v,k)=>sum+v*state.direction[k],0))<1e-8,'Velocity must be tangential');
    const numericalSpeed=magnitude(difference(parkingState(orbit,ms+500).relative,parkingState(orbit,ms-500).relative));
    assert.ok(Math.abs(numericalSpeed-orbit.speedKmS)<1e-4,'Kepler speed must match propagated position');
    const sample=sampleMission(plan,progressAt(id,Math.min(i/100,.999999)),Astronomy);
    const center=orbit.body==='Earth'?[0,0,0]:sample.moon;
    // On the return orbit the picture follows the ascent stage until the docking; the CSM is the one on the orbit.
    assert.ok(Math.abs(magnitude(difference(sample.pair?sample.pair.csm:sample.position,center))-orbit.radiusKm)<1e-7);
    assert.equal(sample.engine,false,'Parking is unpowered');
    const forward=parkingState(orbit,sample.orbitAt).direction;assert.ok(sample.orbitAt>=sample.orbitFrom&&sample.orbitAt-sample.orbitFrom<=Math.max(orbit.turns,1)*orbit.periodSeconds*1000+1,'Drawn orbit stays within its laps');
    assert.ok(sample.direction.reduce((sum,x,k)=>sum+x*forward[k],0)>1-1e-8,'No backward attitude in parking');
    assert.ok(sample.orbitTurns>=0&&sample.orbitTurns<=orbit.turns);
  }
}
// Rendezvous: the CSM is in the picture from the climb on, nothing appears or jumps at the stage change, the gap
// closes steadily to contact, the docked ports meet, and the CSM ends facing along its motion for the injection.
{
  const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0),unit=a=>a.map(x=>x/magnitude(a));
  const climb=sampleMission(plan,progressAt('ascent',.9),Astronomy);
  assert.equal(climb.config,'pair');assert.ok(Math.abs(magnitude(difference(climb.pair.csm,climb.moon))-plan.lunarReturnParking.radiusKm)<1e-7,'CSM in its orbit during the climb');
  assert.ok(climb.pair.rangeKm<2000&&climb.pair.rangeKm>RENDEZVOUS.behindKm,'CSM ahead of the climbing ascent stage');
  const end=sampleMission(plan,progressAt('lunarReturnOrbit',0)-1e-10,Astronomy),start=sampleMission(plan,progressAt('lunarReturnOrbit',0),Astronomy);
  assert.ok(magnitude(difference(end.pair.lm,start.pair.lm))<1e-3,'Ascent stage continuous into the rendezvous');
  assert.ok(magnitude(difference(end.pair.csm,start.pair.csm))<1e-3,'CSM continuous into the rendezvous');
  assert.ok(dot(end.pair.lmAttitude,start.pair.lmAttitude)>.9999,'Ascent stage attitude continuous into the rendezvous');
  assert.ok(Math.abs(start.altitudeKm-(PARKING.lunarAltitudeKm-RENDEZVOUS.belowKm))<.5,'Insertion below the CSM');
  let gap=Infinity;
  for(let i=0;i<=400;i++){
    const s=sampleMission(plan,progressAt('lunarReturnOrbit',RENDEZVOUS.contact*i/400),Astronomy);
    if(i<400){assert.equal(s.pair.status,'rendezvous');assert.ok(s.pair.gapKm<=gap+1e-9,'Gap closes monotonically');gap=s.pair.gapKm;}
    assert.ok(s.pair.lm.every(Number.isFinite)&&s.pair.csm.every(Number.isFinite));
  }
  // Stage progress whose eased presentation clock reads t.
  const progressAtClock=(id,t)=>{let a=0,b=1;for(let i=0;i<60;i++){const m=(a+b)/2;if(presentationTime(m)<t)a=m;else b=m;}return progressAt(id,b);};
  const contact=sampleMission(plan,progressAtClock('lunarReturnOrbit',RENDEZVOUS.contact),Astronomy),axis=unit(difference(contact.pair.csm,contact.pair.lm));
  assert.ok(Math.abs(contact.pair.rangeKm-DOCKED_KM)<1e-6,'Docked: origins 5.33 m apart');
  assert.ok(dot(axis,contact.pair.lmAttitude)>.9999&&dot(axis,contact.pair.csmAttitude)<-.9999,'Docking ports face each other');
  const last=sampleMission(plan,progressAt('lunarReturnOrbit',1)-1e-10,Astronomy),burn=sampleMission(plan,progressAt('tei',0),Astronomy);
  assert.ok(magnitude(difference(last.position,last.pair.csm))<1e-6,'The picture is on the CSM at the end of the stage');
  assert.ok(dot(last.pair.csmAttitude,burn.direction)>.999,'CSM faces along its motion for the injection');
  assert.ok(last.pair.rangeKm>1,'Ascent stage left behind');
}
assert.equal(plan.earthParking.turns,PARKING.earthTurns);
assert.equal(plan.lunarParking.turns,plan.lunarTurns);
const apollo=buildMission({site:sites[0],windowStart:'2026-10-22T18:00:00Z',windowEnd:'2026-10-29T00:00:00Z'},Astronomy);
assert.equal(apollo.lunarTurns,PARKING.lunarTurns,'Apollo 11: 13 lunar orbits before the landing');assert.equal(apollo.lunarReturnTurns,PARKING.lunarReturnTurns);
const coast=(apollo.times.outbound[1]-apollo.times.outbound[0])/HOUR,back=(apollo.times.inbound[1]-apollo.times.inbound[0])/HOUR;
assert.ok(coast>70&&coast<78,`Apollo 11 translunar coast ~73 h, got ${coast}`);assert.ok(back>57&&back<63,`Apollo 11 trans-Earth coast ~60 h, got ${back}`);
for(const site of sites){
  for(const hours of [24,72,240]){
    const candidate=buildMission({site,windowStart:plan.windowStart,windowEnd:plan.windowEnd,outboundHours:hours,inboundHours:hours,elevationKm:4.5},Astronomy);
    for(const id of ['outbound','inbound'])for(let i=0;i<=500;i++){
      const s=sampleMission(candidate,progressAt(id,Math.min(i/500,.999999)),Astronomy);
      assert.ok(magnitude(s.position)>EARTH_RADIUS,`Transfer intersects Earth: ${site.id}/${hours}/${id}/${i}`);
      assert.ok(magnitude(difference(s.position,s.moon))>RADIUS_KM,`Transfer intersects Moon: ${site.id}/${hours}/${id}/${i}`);
    }
    for(const phase of PHASES.slice(1)){
      const left=sampleMission(candidate,phase.start-1e-10,Astronomy),right=sampleMission(candidate,phase.start,Astronomy);
      assert.ok(magnitude(difference(left.position,right.position))<.1,`Boundary: ${site.id}/${hours}/${phase.id}`);
    }
    const ground=sampleMission(candidate,progressAt('surface'),Astronomy);
    assert.ok(magnitude(difference(ground.position,lunarPoint(site,ground.date,Astronomy,4.5)))<1e-7);
    assert.ok(magnitude(ground.localPosition)<1e-7);
  }
}
assert.equal(PHASES.reduce((sum,p)=>sum+p.seconds,0),ANIMATION_SECONDS);
assert.equal(presentationTime(0),0);assert.equal(presentationTime(1),1);
assert.ok(presentationTime(.0001)/.0001<.00001,'Presentation velocity eases in at stage boundaries');
for(const id of ['descent','ascent']){
  const phase=PHASES.find(p=>p.id===id);assert.equal(phase.seconds,20);
  let localSamples=0,previousAltitude=id==='descent'?Infinity:-Infinity;
  for(let i=0;i<1000;i++){
    const s=sampleMission(plan,progressAt(id,i/1000),Astronomy);if(s.local)localSamples++;
    assert.ok(id==='descent'?s.altitudeKm<=previousAltitude+1e-7:s.altitudeKm>=previousAltitude-1e-7,'Monotonic surface flight');previousAltitude=s.altitudeKm;
  }
  assert.ok(localSamples/1000*phase.seconds>13.5,'Restore the extended close-up cutscene');
}
assert.ok(sampleMission(plan,progressAt('descent',.05),Astronomy).altitudeKm<PARKING.lunarAltitudeKm,'Descent begins while the vehicle pitches');
// Exercise camera-frame conversion and interpolation without a GPU or DOM.
const scene=Object.create(MissionScene.prototype),surfaceSample=sampleMission(plan,progressAt('surface',.5),Astronomy);
scene.plan=plan;scene.terrain={height:()=>0};
for(const direction of [false,true]){
  const point=new THREE.Vector3(.08,.024,.11),world=scene.convertView(point,surfaceSample,false,direction),roundtrip=scene.convertView(world,surfaceSample,true,direction);
  assert.ok(roundtrip.distanceTo(point)<1e-7,'Camera must preserve its pose between world and terrain coordinates');
}
scene.camera=new THREE.PerspectiveCamera(45,1,.001,10000);scene.controls={target:new THREE.Vector3(),update(){}};
scene.moon={position:new THREE.Vector3(surfaceSample.moon[0],surfaceSample.moon[2],-surfaceSample.moon[1]).multiplyScalar(.001)};
for(const local of [false,true]){
  const target=local?new THREE.Vector3():scene.moon.position.clone(),from={target:target.clone(),position:target.clone().add(new THREE.Vector3(0,0,local?4:2)),up:new THREE.Vector3(0,1,0)},to={target:target.clone(),position:target.clone().add(new THREE.Vector3(local?.08:5,local?.024:2,local?.11:4)),up:new THREE.Vector3(0,1,0)};
  scene.cameraTween={from,to,local,start:0,duration:1800};scene.animateCamera(0);
  assert.ok(scene.camera.position.distanceTo(from.position)<1e-8,'No camera jump at the beginning of a blend');
  let previous=scene.camera.position.clone();
  for(let i=1;i<=180;i++){scene.animateCamera(i*10);assert.ok(scene.camera.position.toArray().every(Number.isFinite));assert.ok(scene.camera.position.distanceTo(previous)<.2,'Camera blend must be incremental');previous.copy(scene.camera.position);}
  assert.ok(scene.camera.position.distanceTo(to.position)<1e-8);assert.equal(scene.cameraTween,null);
}
const climbSample=sampleMission(plan,progressAt('ascent',.85),Astronomy);
scene.vehicle={group:{position:new THREE.Vector3(climbSample.position[0],climbSample.position[2],-climbSample.position[1]).multiplyScalar(.001)}};scene.mode='auto';scene.setCamera(climbSample,false);
assert.ok(scene.controls.minDistance<scene.camera.position.distanceTo(scene.controls.target),'World controls must allow the close surface camera without forcing a zoom-out');
const padStart=sampleMission(plan,0,Astronomy),padHold=sampleMission(plan,progressAt('liftoff',.1),Astronomy);
assert.equal(padStart.pad,true);assert.equal(padHold.altitudeKm,0,'Hold-down during ignition');assert.ok(Math.abs(sampleMission(plan,progressAt('launch',0),Astronomy).altitudeKm-APOLLO.liftoffAltitudeKm)<1e-6);
console.log('PASS: 15 phases (Apollo 11 profile), preserved mission/window dates, continuous positions and attitudes, forward unpowered parking, Kepler periods/speeds, extended surface cutscenes, monotonic ascent/descent, eased presentation clock, camera-frame roundtrip and smooth camera interpolation, transfer clearance for five sites and 24/72/240 h. Transfers/burns remain illustrative.');
