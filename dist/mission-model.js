import { AU_KM, RADIUS_KM, lunarFrame, siteBasis, clamp } from './model.js';

export const HOUR = 36e5;
export const EARTH_RADIUS = 6378.137;
// JPL DE440, km³/s²: https://ssd.jpl.nasa.gov/astro_par.html
export const EARTH_MU = 398600.435507;
export const MOON_MU = 4902.800118;
// Mission profile of the crewed lunar landings that actually flew (Apollo 11–17), with the numbers of
// Apollo 11: NASA, Apollo 11 Mission Report (MSC-00171, 1969). Parking orbits: 185 km around the
// Earth, ~110 km around the Moon; 13 lunar orbits before the landing and 5 after the liftoff.
// On arrival the scene goes straight to the landing point: the burn into lunar orbit ends a quarter of a lap
// before the descent starts, and only that last arc is drawn, while the clock runs through every orbit.
export const ARRIVAL_ARC = .25;
export const PARKING = Object.freeze({ earthAltitudeKm:185, lunarAltitudeKm:110, earthTurns:1.5, lunarTurns:13, lunarReturnTurns:5 });
export const APOLLO = Object.freeze({
  launchSite:{ lat:28.6083, lon:-80.6041 }, launchAzimuth:72.06,
  outboundHours:103, stayHours:22, inboundHours:71,
  // Splashdown in the Pacific (Apollo 11: 13°19' N, 169°09' W), entry 15.5 min before it.
  splashdown:{ lat:13.32, lon:-169.15 }, entryAltitudeKm:121.9, entryRangeKm:2600, entryAngleDeg:6.5,
  entryMinutes:15.5, chuteMinutes:7, drogueAltitudeKm:7.3, mainAltitudeKm:3.2,
  // Liftoff seen from the ground: ignition, then the first 50 s and ~3.4 km of the climb.
  liftoffSeconds:50, liftoffAltitudeKm:3.4
});
// Presentation time is independent of the mission's UTC timeline.
// Errors carry the code of their text in i18n.js (mission.err.*), so the panel shows them in the chosen language.
const missionError=(code,message)=>Object.assign(new Error(message),{code:`mission.err.${code}`});
const PHASE_TABLE = [
  ['liftoff','Decolagem',9],['launch','Subida à órbita',10],['earthOrbit','Órbita terrestre',14],['tli','Injeção translunar',4],
  ['outbound','Ida à Lua',12],['loi','Inserção lunar',4],['lunarOrbit','Órbita lunar',5],
  ['descent','Pouso lunar',20],['surface','No solo',8],['ascent','Decolagem lunar',20],
  ['lunarReturnOrbit','Órbita lunar / volta',20],['tei','Injeção à Terra',4],['inbound','Volta à Terra',16],
  ['arrival','Reentrada',8],['splashdown','Paraquedas e amerissagem',8]
];
export const ANIMATION_SECONDS=PHASE_TABLE.reduce((sum,p)=>sum+p[2],0);
export const PHASES = PHASE_TABLE.map(([id,label,seconds],i,all)=>{const before=all.slice(0,i).reduce((sum,p)=>sum+p[2],0);return {id,label,seconds,start:before/ANIMATION_SECONDS,end:(before+seconds)/ANIMATION_SECONDS};});
export const LOCAL_DESCENT_START=.25,LOCAL_ASCENT_END=.70;
// Rendezvous after the lunar liftoff, on Apollo 11's timeline (GET): liftoff 124:22, docking 128:03, ascent stage
// jettison 130:10, trans-Earth injection 135:24. The fractions are of the return lunar orbit stage, whose clock runs
// from the orbit insertion to the injection. The ascent stage reaches orbit behind and below the CSM, as in the
// coelliptic rendezvous flown from Apollo 11 on, and closes on it: the CSM is in the picture from the climb on.
export const RENDEZVOUS=Object.freeze({behindKm:70,belowKm:22,contact:.35,capture:.38,jettison:.56,separated:.64,turned:.8});
// Docking interface of NASA's models (nasa-models.js): the LM drogue 2.75 m above the ascent stage's base, the CSM
// probe tip 2.58 m ahead of the command module's base. Docked, the two origins are 5.33 m apart.
export const LM_PORT_KM=.00275,CSM_PROBE_KM=.0025786,DOCKED_KM=LM_PORT_KM+CSM_PROBE_KM;
const TAU = 2*Math.PI;
const add = (a,b) => a.map((v,i)=>v+b[i]);
const subtract = (a,b) => a.map((v,i)=>v-b[i]);
const scale = (a,k) => a.map(v=>v*k);
const dot = (a,b) => a.reduce((sum,v,i)=>sum+v*b[i],0);
const norm = a => Math.hypot(...a);
const unit = a => scale(a,1/norm(a));
const mix = (a,b,t) => a+(b-a)*t;
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const smooth = t => t*t*(3-2*t);
const ramp = (a,b,x) => smooth(Math.min(1,Math.max(0,(x-a)/(b-a))));
// Great-circle interpolation of unit vectors.
function slerp(a,b,t){
  const c=clamp(dot(a,b),-1,1),w=Math.acos(c);
  if(w<1e-6)return unit(add(scale(a,1-t),scale(b,t)));
  return add(scale(a,Math.sin((1-t)*w)/Math.sin(w)),scale(b,Math.sin(t*w)/Math.sin(w)));
}
// Ease only the presentation clock over the outer 8% of a stage. Analytic
// parking motion still has the correct speed/period as a function of UTC.
export function presentationTime(t){
  const edge=.08;if(t>1-edge)return 1-presentationTime(1-t);
  if(t<edge){const s=t/edge;return edge*(s**3-.5*s**4)/(1-edge);}
  return (t-edge/2)/(1-edge);
}
const rotate = (p,q,angle) => add(scale(p,Math.cos(angle)),scale(q,Math.sin(angle)));
const tangent = (p,q,angle) => add(scale(p,-Math.sin(angle)),scale(q,Math.cos(angle)));
const bezier = (a,b,c,d,t) => add(add(scale(a,(1-t)**3),scale(b,3*(1-t)**2*t)),add(scale(c,3*(1-t)*t*t),scale(d,t**3)));
const hermite=(a,b,da,db,t)=>(2*t**3-3*t*t+1)*a+(t**3-2*t*t+t)*da+(-2*t**3+3*t*t)*b+(t**3-t*t)*db;
const phaseWidth=id=>{const p=PHASES.find(p=>p.id===id);return p.end-p.start;};
export function toInertial(v,frame){return v.map((_,i)=>frame.x[i]*v[0]+frame.y[i]*v[1]+frame.z[i]*v[2]);}
export function moonPosition(date,astronomy){const v=astronomy.GeoMoon(date);return [v.x*AU_KM,v.y*AU_KM,v.z*AU_KM];}
export function geoPoint(lat,lon,date,astronomy,altitudeKm=0){
  const v=astronomy.ObserverVector(date,new astronomy.Observer(lat,lon,altitudeKm*1000),false);
  return [v.x*AU_KM,v.y*AU_KM,v.z*AU_KM];
}
export function terrestrialPoint(date,astronomy,altitudeKm=0){return geoPoint(APOLLO.launchSite.lat,APOLLO.launchSite.lon,date,astronomy,altitudeKm);}
// Local east and north at a geographic point, in the inertial (EQJ) frame.
function geoAxes(lat,lon,date,astronomy){
  const p=geoPoint(lat,lon,date,astronomy),east=unit(subtract(geoPoint(lat,lon+.01,date,astronomy),p)),north=unit(subtract(geoPoint(lat+.01,lon,date,astronomy),p));
  return {p,up:unit(p),east,north};
}
const RAD=Math.PI/180;
const fixed=(lat,lon)=>[Math.cos(lat*RAD)*Math.cos(lon*RAD),Math.cos(lat*RAD)*Math.sin(lon*RAD),Math.sin(lat*RAD)];
const geographic=e=>({lat:Math.asin(clamp(e[2],-1,1))/RAD,lon:Math.atan2(e[1],e[0])/RAD});
// Point at a fraction of the great circle between two geographic points.
function alongTrack(a,b,f){
  const p=fixed(a.lat,a.lon),q=fixed(b.lat,b.lon),omega=Math.acos(clamp(dot(p,q),-1,1));
  if(omega<1e-9)return {...b};
  return geographic(add(scale(p,Math.sin((1-f)*omega)/Math.sin(omega)),scale(q,Math.sin(f*omega)/Math.sin(omega))));
}
// Entry: from the entry interface (121.9 km) to the drogue chutes (7.3 km) over the Pacific.
export function entryPoint(plan,s,astronomy){
  const [begin,end]=plan.times.arrival,date=new Date(mix(begin,end,s));
  // Ends at the drogue deployment falling at the speed the chute phase starts with (~80 m/s).
  const [c0,c1]=plan.times.splashdown,fall=(APOLLO.drogueAltitudeKm-APOLLO.mainAltitudeKm)/.12*(end-begin)/(c1-c0);
  const g=1-Math.pow(1-s,2.2),altitudeKm=APOLLO.drogueAltitudeKm+fall*(1-s)+(APOLLO.entryAltitudeKm-APOLLO.drogueAltitudeKm-fall)*Math.pow(1-s,2.5);
  const at=alongTrack(plan.entry.from,plan.entry.to,g);
  return {position:geoPoint(at.lat,at.lon,date,astronomy,altitudeKm),altitudeKm};
}
// Drogues at 7.3 km, three mains at 3.2 km, splashdown at the target.
export function splashdownPoint(plan,s,astronomy){
  const [begin,end]=plan.times.splashdown,date=new Date(mix(begin,end,s)),to=plan.entry.to;
  const altitudeKm=s<.12?mix(APOLLO.drogueAltitudeKm,APOLLO.mainAltitudeKm,s/.12):APOLLO.mainAltitudeKm*(1-(s-.12)/.88);
  return {position:geoPoint(to.lat,to.lon,date,astronomy,Math.max(0,altitudeKm)),altitudeKm:Math.max(0,altitudeKm)};
}
export function lunarPoint(site,date,astronomy,elevationKm=0,altitudeKm=0){
  return add(moonPosition(date,astronomy),toInertial(scale(siteBasis(site).up,RADIUS_KM+elevationKm+altitudeKm),lunarFrame(date,astronomy)));
}

// Analytic circular two-body motion in a fixed EQJ plane. This is not an
// Earth–Moon transfer solver, a gravity assist, or a propellant calculation.
export function circularOrbit({body,radiusKm,mu,p,q,start,turns}){
  const radial=unit(p),side=unit(subtract(q,scale(radial,dot(q,radial))));
  const angularRate=Math.sqrt(mu/radiusKm**3),periodSeconds=TAU/angularRate;
  return {body,radiusKm,mu,p:radial,q:side,normal:unit(cross(radial,side)),start,turns,
    angularRate,periodSeconds,speedKmS:Math.sqrt(mu/radiusKm),end:start+turns*periodSeconds*1000};
}
export function parkingState(orbit,ms,radiusKm=orbit.radiusKm){
  const angle=orbit.angularRate*(ms-orbit.start)/1000;
  return {relative:scale(rotate(orbit.p,orbit.q,angle),radiusKm),direction:tangent(orbit.p,orbit.q,angle),angle};
}
export function parkingPath(orbit){
  return Array.from({length:193},(_,i)=>scale(rotate(orbit.p,orbit.q,TAU*i/192),orbit.radiusKm));
}
// The CSM's local frame on a circular orbit: x along the motion, y across (the orbit normal), z up from the centre.
function localFrame(orbit,ms){
  const s=parkingState(orbit,ms),z=unit(s.relative),x=s.direction;
  return {x,y:cross(z,x),z,relative:s.relative};
}
const toLocal=(f,v)=>[dot(v,f.x),dot(v,f.y),dot(v,f.z)];
const fromLocal=(f,c)=>add(add(scale(f.x,c[0]),scale(f.y,c[1])),scale(f.z,c[2]));
// Final approach from the insertion (k = 0) to contact (k = 1). The gap between the docking ports falls geometrically
// to 30 m, so the CSM grows in the picture at a steady rate, as through the LM's window; the last 30 m are flown slowly,
// with a metre of offset across the docking axis taken out before contact. The line of sight turns from below and
// behind the CSM to straight behind it. RCS bursts brake the closing speed at the range gates.
function approach(R,k){
  const g0=R.range0-DOCKED_KM,k1=.82,g1=.03;
  const gap=k<k1?g0*Math.pow(g1/g0,k/k1):g1*Math.pow(1-(k-k1)/(1-k1),1.5);
  const u=slerp(R.u0,[1,0,0],ramp(.04,.8,k)),across=.0012*ramp(.55,.75,k)*(1-ramp(.85,.97,k));
  const rcs=gap<=0?0:Math.max(...[1.5,.45,.12,.03,.01,.003].map(g=>Math.exp(-(((Math.log(gap)-Math.log(g))/.12)**2))));
  return {gap,u,across,rcs};
}
// Both spacecraft from the orbit insertion to the trans-Earth injection, on the CSM's orbit point `at` (the stage clock
// at fraction t). Positions are absolute (km, like every sample position); focus runs from the ascent stage (0) to the
// CSM (1) and is what the scene follows.
function rendezvousState(plan,at,t,moon){
  const R=RENDEZVOUS,f=localFrame(plan.lunarReturnParking,at);
  let rel,lm,csm,focus=0,status=null,gap=0,rcs=0;
  if(t<R.contact){
    const a=approach(plan.rendezvous,t/R.contact);
    rel=add(scale(a.u,-(DOCKED_KM+a.gap)),[0,a.across,0]);
    lm=slerp(plan.rendezvous.lm0,a.u,ramp(0,.12,t/R.contact));csm=scale(a.u,-1);status='rendezvous';gap=a.gap;rcs=a.rcs;
  }else if(t<R.jettison){
    // Capture: the probe's latches hold, the vehicles rock a little and settle.
    const s=clamp((t-R.contact)/(R.capture-R.contact),0,1),rock=.03*Math.exp(-3*s)*Math.sin(3*Math.PI*s);
    rel=[-DOCKED_KM,0,0];lm=[Math.cos(rock),0,Math.sin(rock)];csm=[-1,0,0];status='docked';
    focus=.72*ramp(0,.08,t-R.contact);
  }else{
    // The CSM backs away from the cast-off ascent stage, which tumbles slowly, then yaws round to face along its
    // motion for the injection burn; the stage stays behind in lunar orbit.
    const u=(t-R.jettison)/(1-R.jettison),sep=2*Math.pow(u,2.6),yaw=Math.PI*ramp(R.separated,R.turned,t);
    rel=[-(DOCKED_KM+sep),0,-.04*sep];lm=[Math.cos(.5*u),0,Math.sin(.5*u)];csm=[-Math.cos(yaw),-Math.sin(yaw),0];
    focus=.72+.28*ramp(R.jettison,R.separated+.04,t);status=t<R.separated?'jettison':t<R.turned?'turn':null;gap=sep;
  }
  const csmAt=add(moon,f.relative),lmAt=add(csmAt,fromLocal(f,rel));
  return {lm:lmAt,csm:csmAt,lmAttitude:unit(fromLocal(f,lm)),csmAttitude:unit(fromLocal(f,csm)),focus,status,gapKm:gap,rangeKm:norm(subtract(csmAt,lmAt)),rcs};
}
// insertion: the ascent stage's own climb, which ends behind and below the CSM (RENDEZVOUS); without it, the arc
// ends at the CSM's point in the 110 km orbit (that point defines the return orbit).
function lunarArc(plan,ms,t,ascending,astronomy,insertion=ascending){
  const frame=lunarFrame(new Date(ms),astronomy),basis=siteBasis(plan.site);
  const ground=RADIUS_KM+plan.elevationKm,parking=RADIUS_KM+PARKING.lunarAltitudeKm;
  const local=ascending?t<=LOCAL_ASCENT_END:t>=LOCAL_DESCENT_START;
  const top=insertion?parking-RENDEZVOUS.belowKm:parking,arc=plan.landingArc-(insertion?RENDEZVOUS.behindKm/parking:0);
  let angle=0,radius;
  if(local){
    const s=ascending?t/LOCAL_ASCENT_END:(t-LOCAL_DESCENT_START)/(1-LOCAL_DESCENT_START);
    radius=ground+.4*(ascending?smooth(s):1-smooth(s));
  }else{
    const span=ascending?1-LOCAL_ASCENT_END:LOCAL_DESCENT_START,s=ascending?(t-LOCAL_ASCENT_END)/span:t/span;
    const rate=Math.sqrt(MOON_MU/parking**3),slope=rate*.25*HOUR/1000*span;
    angle=ascending?hermite(0,arc,0,slope,s):hermite(-plan.landingArc,0,slope,0,s);
    radius=mix(ground+.4,top,ascending?smooth(s):1-smooth(s));
  }
  const radial=toInertial(rotate(basis.up,basis.north,angle),frame);
  return {relative:scale(radial,radius),radial,direction:toInertial(tangent(basis.up,basis.north,angle),frame),local,altitudeKm:radius-ground};
}
function rawTransferPoint(plan,id,t,astronomy){
  const outbound=id==='outbound',curve=outbound?plan.outboundCurve:plan.inboundCurve;
  const [begin,end]=plan.times[id],moon=moonPosition(new Date(mix(begin,end,t)),astronomy);
  const reference=outbound?plan.outboundMoonReference:plan.inboundMoonReference;
  // Blend the lunar ephemeris into the illustrative curve near the lunar end.
  // This keeps a long visual transfer from crossing the Moon's moving sphere.
  return add(bezier(...curve,t),scale(subtract(moon,reference),outbound?smooth(t):1-smooth(t)));
}
const LINK_SPAN=.02;
function burnPoint(plan,id,t,astronomy){
  const [begin,end]=plan.times[id],ms=mix(begin,end,t),u=smooth(t);
  const orbit=id==='tli'?plan.earthParking:id==='loi'?plan.lunarParking:plan.lunarReturnParking;
  const radius=orbit.radiusKm+(id==='tli'?80*u:id==='loi'?200*(1-u):200*u);
  const relative=parkingState(orbit,ms,radius).relative;
  return orbit.body==='Earth'?relative:add(moonPosition(new Date(ms),astronomy),relative);
}
function makeTransferLinks(plan,id,astronomy){
  const span=plan[id+'LinkSpan'];
  const outbound=id==='outbound',before=outbound?'tli':'tei',after=outbound?'loi':'arrival';
  const endpoint=(phase,t)=>phase==='arrival'?entryPoint(plan,t,astronomy).position:burnPoint(plan,phase,t,astronomy);
  const derivative=(fn,t)=>{const a=Math.max(0,t-.001),b=Math.min(1,t+.001);return scale(subtract(fn(b),fn(a)),1/(b-a));};
  const raw=t=>rawTransferPoint(plan,id,t,astronomy),a=raw(0),b=raw(span),c=raw(1-span),d=raw(1);
  // Match d(position)/d(animation progress) at both ends. The UTC mapping is
  // compressed differently by stage: these are visual C1 links, not burns solved by dynamics.
  const startHandle=scale(derivative(t=>endpoint(before,t),1),phaseWidth(id)*span/phaseWidth(before)/3);
  const endHandle=scale(derivative(t=>endpoint(after,t),0),phaseWidth(id)*span/phaseWidth(after)/3);
  return {first:[a,add(a,startHandle),subtract(b,scale(derivative(raw,span),span/3)),b],
    last:[c,add(c,scale(derivative(raw,1-span),span/3)),subtract(d,endHandle),d]};
}
function transferPoint(plan,id,t,astronomy){
  const links=plan[id+'Links'],span=plan[id+'LinkSpan'];
  if(t<span)return bezier(...links.first,t/span);
  if(t>1-span)return bezier(...links.last,(t-1+span)/span);
  return rawTransferPoint(plan,id,t,astronomy);
}
function selectTransferCurve(plan,id,astronomy){
  const key=id==='outbound'?'outboundCurve':'inboundCurve',original=plan[key];
  const reference=id==='outbound'?plan.outboundMoonReference:plan.inboundMoonReference;
  const [begin,end]=plan.times[id];
  const samples=Array.from({length:1001},(_,i)=>{
    const t=i/1000,moon=moonPosition(new Date(mix(begin,end,t)),astronomy);
    return {t,moon,shift:scale(subtract(moon,reference),id==='outbound'?smooth(t):1-smooth(t))};
  });
  // Select only visual control handles, NOT an orbital/fuel optimization.
  // Reject geometric links that intersect either moving reference sphere.
  for(const span of [LINK_SPAN,.01,.005])for(const first of [1,1.5,2,3,4])for(const last of [1,1.5,2,3,4]){
    const [a,b,c,d]=original,curve=[a,add(a,scale(subtract(b,a),first)),add(d,scale(subtract(c,d),last)),d];
    plan[key]=curve;plan[id+'LinkSpan']=span;const links=makeTransferLinks(plan,id,astronomy);plan[id+'Links']=links;
    const clear=(point,moon)=>norm(point)>EARTH_RADIUS+50&&norm(subtract(point,moon))>RADIUS_KM+50;
    const connectorSamples=Array.from({length:101},(_,i)=>i/100).flatMap(s=>[s*span,1-span+s*span]);
    if(samples.every(({t,moon,shift})=>clear(t<span?bezier(...links.first,t/span):t>1-span?bezier(...links.last,(t-1+span)/span):add(bezier(...curve,t),shift),moon))&&
      connectorSamples.every(t=>clear(transferPoint(plan,id,t,astronomy),moonPosition(new Date(mix(begin,end,t)),astronomy)))){
      return;
    }
  }
  throw missionError('cross','Não foi possível ligar as órbitas sem cruzar os globos. Experimente outra data ou duração de viagem.');
}

export function buildMission({site,windowStart,windowEnd,outboundHours=APOLLO.outboundHours,stayHours=APOLLO.stayHours,inboundHours=APOLLO.inboundHours,elevationKm=0},astronomy){
  const start=new Date(windowStart),end=new Date(windowEnd),arrival=+start,departure=arrival+stayHours*HOUR;
  if(!Number.isFinite(+start)||!Number.isFinite(+end)||end<=start)throw missionError('window','Janela inválida.');
  for(const hours of [outboundHours,inboundHours])if(!Number.isFinite(hours)||hours<24||hours>240)throw missionError('trip','As viagens devem durar de 24 a 240 horas.');
  if(!Number.isFinite(stayHours)||stayHours<.5||departure>+end)throw missionError('stay','A permanência precisa caber na janela escolhida (mínimo de 0,5 h).');
  if(!Number.isFinite(elevationKm)||Math.abs(elevationKm)>20)throw missionError('elevation','Elevação lunar inválida.');
  // Recovery in daylight, as the Apollo flight planners targeted: when the whole Pacific recovery band is
  // dark at the nominal return, the trip back is lengthened or shortened by the smallest amount that puts
  // the Sun at least 15° up over some point of it (at most ±10 h, staying within 24–240 h).
  const sunOverPacific=date=>{let best=-90;for(let east=150;east<=240;east+=5){const lon=east>180?east-360:east,observer=new astronomy.Observer(APOLLO.splashdown.lat,lon,0),eq=astronomy.Equator(astronomy.Body.Sun,date,observer,true,true);best=Math.max(best,astronomy.Horizon(date,observer,eq.ra,eq.dec,'normal').altitude);}return best;};
  let returnShiftHours=0;
  if(sunOverPacific(new Date(departure+inboundHours*HOUR))<15){
    for(const step of Array.from({length:40},(_,i)=>(i>>1)*.5+.5).map((h,i)=>i%2?-h:h)){
      const hours=inboundHours+step;if(hours<24||hours>240)continue;
      if(sunOverPacific(new Date(departure+hours*HOUR))>=15){returnShiftHours=step;break;}
    }
  }
  const launch=arrival-outboundHours*HOUR,returnAt=departure+(inboundHours+returnShiftHours)*HOUR;
  if(launch<+new Date('2000-01-01T00:00Z')||returnAt>+new Date('2050-12-31T23:59Z'))throw missionError('years','Toda a missão deve ficar entre 2000 e 2050.');
  const plan={site,windowStart:start,windowEnd:end,outboundHours,stayHours,inboundHours,returnShiftHours,elevationKm,launch,arrival,departure,returnAt,landingArc:Math.PI/5};
  // Launch from Kennedy LC-39A along the Apollo 11 flight azimuth (72°); orbit insertion ~1,800 km downrange.
  const pad=geoAxes(APOLLO.launchSite.lat,APOLLO.launchSite.lon,new Date(launch),astronomy),az=APOLLO.launchAzimuth*RAD;
  const p=pad.up,heading=add(scale(pad.north,Math.cos(az)),scale(pad.east,Math.sin(az))),q=unit(subtract(heading,scale(p,dot(heading,p))));
  plan.launchFrame={p,q,radiusKm:norm(pad.p),angle:.28};
  // Lunar orbits: Apollo 11 numbers, fewer when the chosen trip is shorter.
  const lunarPeriodHours=TAU*Math.sqrt((RADIUS_KM+PARKING.lunarAltitudeKm)**3/MOON_MU)/3600;
  const backHours=inboundHours+returnShiftHours,coastOut=outboundHours>=100?72:.7*(outboundHours-3),coastBack=backHours>=70?59:.75*(backHours-.6);
  plan.lunarTurns=clamp(Math.floor((outboundHours-3-coastOut)/lunarPeriodHours),1,PARKING.lunarTurns);
  plan.lunarReturnTurns=clamp(Math.floor((backHours-.6-coastBack)/lunarPeriodHours),1,PARKING.lunarReturnTurns);
  plan.earthParking=circularOrbit({body:'Earth',radiusKm:EARTH_RADIUS+PARKING.earthAltitudeKm,mu:EARTH_MU,
    p:rotate(p,q,plan.launchFrame.angle),q:tangent(p,q,plan.launchFrame.angle),start:launch+.2*HOUR,turns:PARKING.earthTurns});
  const descentStart=arrival-.25*HOUR,ascentEnd=departure+.25*HOUR;
  const descentEntry=lunarArc(plan,descentStart,0,false,astronomy),ascentExit=lunarArc(plan,ascentEnd,1,true,astronomy,false);
  const lunarPeriod=TAU*Math.sqrt((RADIUS_KM+PARKING.lunarAltitudeKm)**3/MOON_MU);
  plan.lunarParking=circularOrbit({body:'Moon',radiusKm:RADIUS_KM+PARKING.lunarAltitudeKm,mu:MOON_MU,
    p:descentEntry.relative,q:descentEntry.direction,start:descentStart-plan.lunarTurns*lunarPeriod*1000,turns:plan.lunarTurns});
  plan.lunarReturnParking=circularOrbit({body:'Moon',radiusKm:RADIUS_KM+PARKING.lunarAltitudeKm,mu:MOON_MU,
    p:ascentExit.relative,q:ascentExit.direction,start:ascentEnd,turns:plan.lunarReturnTurns});
  // Where the rendezvous starts, in the CSM's local frame at the orbit insertion: the line of sight to the CSM, its
  // range and the ascent stage's attitude (its docking hatch, on top, faces along the motion after the climb).
  {
    const insertion=lunarArc(plan,ascentEnd,1,true,astronomy),f=localFrame(plan.lunarReturnParking,ascentEnd),rho=subtract(f.relative,insertion.relative),range=norm(rho);
    plan.rendezvous={range0:range,u0:toLocal(f,scale(rho,1/range)),lm0:toLocal(f,insertion.direction)};
  }
  const tliStart=plan.earthParking.end,tliEnd=tliStart+.1*HOUR;
  const loiEnd=plan.lunarParking.start,loiStart=loiEnd-.1*HOUR;
  // Whole turns: the orbit is at the same point at its start and end, so the burn can be drawn on the final arc.
  plan.arrivalShift=ARRIVAL_ARC*plan.lunarParking.periodSeconds*1000;
  const teiStart=plan.lunarReturnParking.end,teiEnd=teiStart+.05*HOUR,reentryStart=returnAt-APOLLO.entryMinutes*60000,chuteStart=returnAt-APOLLO.chuteMinutes*60000;
  if(tliEnd>=loiStart||teiEnd>=reentryStart)throw missionError('duration','A duração não comporta as órbitas e manobras.');
  plan.launchFrame.climb=(plan.earthParking.radiusKm-plan.launchFrame.radiusKm)/PARKING.earthAltitudeKm;
  const liftoffEnd=launch+APOLLO.liftoffSeconds*1000;
  plan.times={liftoff:[launch,liftoffEnd],launch:[liftoffEnd,plan.earthParking.start],earthOrbit:[plan.earthParking.start,tliStart],tli:[tliStart,tliEnd],
    outbound:[tliEnd,loiStart],loi:[loiStart,loiEnd],lunarOrbit:[loiEnd,descentStart],descent:[descentStart,arrival],
    surface:[arrival,departure],ascent:[departure,ascentEnd],lunarReturnOrbit:[ascentEnd,teiStart],tei:[teiStart,teiEnd],
    inbound:[teiEnd,reentryStart],arrival:[reentryStart,chuteStart],splashdown:[chuteStart,returnAt]};
  // Entry ground track: comes in along the plane of the trip back (from the Moon's direction at the
  // trans-Earth injection), 6.5° below the horizon, and ends at the splashdown point in the Pacific.
  {
    // Recovery needs daylight: the splashdown longitude is chosen inside the Pacific (150° E to 120° W),
    // closest to Apollo 11's point among those with the Sun at least 15° up; otherwise the highest Sun.
    let to=APOLLO.splashdown,bestScore=-Infinity;
    for(let east=150;east<=240;east+=2.5){
      const lon=east>180?east-360:east,observer=new astronomy.Observer(APOLLO.splashdown.lat,lon,0),eq=astronomy.Equator(astronomy.Body.Sun,new Date(returnAt),observer,true,true);
      const sun=astronomy.Horizon(new Date(returnAt),observer,eq.ra,eq.dec,'normal').altitude,score=sun>=15?1000-Math.abs(((lon-APOLLO.splashdown.lon+540)%360)-180):sun;
      if(score>bestScore){bestScore=score;to={lat:APOLLO.splashdown.lat,lon};}
    }
    const moonAtTei=moonPosition(new Date(teiEnd),astronomy),at=geoAxes(to.lat,to.lon,new Date(reentryStart),astronomy);
    let normal=cross(moonAtTei,at.p);if(norm(normal)<1e-6*norm(moonAtTei)*norm(at.p))normal=cross(at.p,[0,0,1]);
    const track=unit(cross(unit(normal),at.up)),bearing=Math.atan2(dot(track,at.east),dot(track,at.north));
    const back=APOLLO.entryRangeKm/EARTH_RADIUS,lat1=to.lat*RAD,b=bearing+Math.PI;
    const lat2=Math.asin(Math.sin(lat1)*Math.cos(back)+Math.cos(lat1)*Math.sin(back)*Math.cos(b));
    const lon2=to.lon*RAD+Math.atan2(Math.sin(b)*Math.sin(back)*Math.cos(lat1),Math.cos(back)-Math.sin(lat1)*Math.sin(lat2));
    plan.entry={from:{lat:lat2/RAD,lon:((lon2/RAD+540)%360)-180},to:{...to}};
  }
  // Burn arcs and transfers are illustrative links between the
  // analytic parking orbits. No Lambert targeting, delta-v, or n-body dynamics.
  const earthExit=parkingState(plan.earthParking,tliEnd,plan.earthParking.radiusKm+80);
  const moonEntry=parkingState(plan.lunarParking,loiStart-plan.arrivalShift,plan.lunarParking.radiusKm+200);
  const moonExit=parkingState(plan.lunarReturnParking,teiEnd,plan.lunarReturnParking.radiusKm+200);
  const moonVelocity=ms=>scale(subtract(moonPosition(new Date(ms+1000),astronomy),moonPosition(new Date(ms-1000),astronomy)),.5);
  const makeCurve=(a,d,da,dd)=>{const handle=norm(subtract(d,a))*.22;return [a,add(a,scale(unit(da),handle)),subtract(d,scale(unit(dd),handle)),d];};
  plan.outboundCurve=makeCurve(earthExit.relative,add(moonPosition(new Date(loiStart),astronomy),moonEntry.relative),add(earthExit.direction,scale(unit(earthExit.relative),.8)),
    add(add(scale(moonEntry.direction,plan.lunarParking.speedKmS),moonVelocity(loiStart)),scale(unit(moonEntry.relative),-1.5)));
  const endEarth=entryPoint(plan,0,astronomy).position,entryDirection=unit(subtract(entryPoint(plan,.002,astronomy).position,endEarth));
  plan.inboundCurve=makeCurve(add(moonPosition(new Date(teiEnd),astronomy),moonExit.relative),endEarth,
    add(add(scale(moonExit.direction,plan.lunarReturnParking.speedKmS),moonVelocity(teiEnd)),scale(unit(moonExit.relative),1.5)),entryDirection);
  plan.outboundMoonReference=moonPosition(new Date(loiStart),astronomy);plan.inboundMoonReference=moonPosition(new Date(teiEnd),astronomy);
  selectTransferCurve(plan,'outbound',astronomy);selectTransferCurve(plan,'inbound',astronomy);
  plan.outboundPath=Array.from({length:201},(_,i)=>transferPoint(plan,'outbound',i/200,astronomy));
  plan.inboundPath=Array.from({length:201},(_,i)=>transferPoint(plan,'inbound',i/200,astronomy));
  return plan;
}

export function sampleMission(plan,progress,astronomy){
  const p=clamp(progress,0,1),phase=PHASES.find(s=>p<s.end)||PHASES.at(-1),t=presentationTime(clamp((p-phase.start)/(phase.end-phase.start),0,1)),u=smooth(t);
  const [begin,end]=plan.times[phase.id],ms=mix(begin,end,t),date=new Date(ms),moon=moonPosition(date,astronomy),frame=lunarFrame(date,astronomy);
  let position,direction,attitude=null,altitudeKm=0,local=false,engine=false,throttle=0,orbit=null,arc=null,altitudeReference='Terra',config='csm',plasma=0,chutes=null,ocean=false,pad=false,ignition=1,pair=null;
  // The clock runs through every lunar orbit (13 before the landing, 5 after the liftoff on Apollo 11); the
  // picture shows only the final arc into the descent on arrival, and one lap on the way out.
  let orbitFrom=null,orbitAt=null;
  const around=(parking,radius,at=ms)=>{const state=parkingState(parking,at,radius);direction=state.direction;position=parking.body==='Earth'?state.relative:add(moon,state.relative);altitudeReference=parking.body==='Earth'?'Terra':'Lua';altitudeKm=norm(state.relative)-(parking.body==='Earth'?EARTH_RADIUS:RADIUS_KM);};
  switch(phase.id){
    case 'liftoff':{
      // On the pad: ignition and hold-down for the first 15% of the stage, then straight up.
      const f=plan.launchFrame,k=clamp((t-.15)/.85,0,1);altitudeKm=APOLLO.liftoffAltitudeKm*Math.pow(k,2.2);
      position=scale(f.p,f.radiusKm+altitudeKm*f.climb);direction=f.p;engine=true;throttle=1;config='saturnV';pad=true;ignition=clamp(t/.15,0,1);break;
    }
    case 'launch':{
      // Gravity turn: climbs almost vertically, then pitches over to orbital speed at 185 km.
      const f=plan.launchFrame,h0=APOLLO.liftoffAltitudeKm,alt=k=>h0+(PARKING.earthAltitudeKm-h0)*(1-Math.pow(1-clamp(k,0,1),2.2));
      const at=s=>scale(rotate(f.p,f.q,f.angle*Math.pow(clamp(s,0,1),1.8)),f.radiusKm+alt(s)*f.climb);
      position=at(t);direction=unit(subtract(at(t+1e-4),at(t-1e-4)));
      altitudeKm=alt(t);engine=true;throttle=1;
      // S-IC burns 2 min 41 s, S-II until 9 min 9 s, S-IVB to orbit insertion at 11 min 39 s.
      config=t<.23?'saturnV':t<.785?'stage2':'sivb';break;
    }
    case 'earthOrbit':orbit=plan.earthParking;orbitFrom=orbit.start;orbitAt=ms;around(orbit);config='sivb';break;
    case 'tli':around(plan.earthParking,plan.earthParking.radiusKm+80*u);engine=true;throttle=1;config='sivb';break;
    case 'loi':around(plan.lunarParking,plan.lunarParking.radiusKm+200*(1-u),ms-plan.arrivalShift);engine=true;throttle=1;config='stack';break;
    case 'lunarOrbit':{orbit=plan.lunarParking;const arc=plan.arrivalShift;orbitFrom=orbit.end-arc;orbitAt=orbitFrom+arc*t;around(orbit,undefined,orbitAt);config='stack';break;}
    case 'lunarReturnOrbit':{orbit=plan.lunarReturnParking;const lap=orbit.periodSeconds*1000;orbitFrom=orbit.start;orbitAt=orbitFrom+lap*t;around(orbit,undefined,orbitAt);
      // The CSM rides the drawn lap; the ascent stage closes on it, docks, is cast off. The picture follows the ascent
      // stage until the docking, then the CSM (direction stays the CSM's motion along its orbit).
      config='pair';pair=rendezvousState(plan,orbitAt,t,moon);position=add(pair.lm,scale(subtract(pair.csm,pair.lm),pair.focus));
      altitudeKm=norm(subtract(position,moon))-RADIUS_KM;break;}
    case 'tei':around(plan.lunarReturnParking,plan.lunarReturnParking.radiusKm+200*u);engine=true;throttle=1;config='csm';break;
    case 'descent':case 'ascent':{
      arc=lunarArc(plan,ms,t,phase.id==='ascent',astronomy);position=add(moon,arc.relative);altitudeKm=Math.max(0,arc.altitudeKm);
      local=arc.local;engine=phase.id==='descent'?t<.999:t>.001;altitudeReference='solo lunar';
      // Descent brakes with the engine forward, then pitches up to land vertically; the ascent stage
      // rises vertically and pitches over towards the orbit. The descent stage stays on the Moon.
      const pitch=phase.id==='descent'?smooth(clamp(t/LOCAL_DESCENT_START,0,1)):1-smooth(clamp((t-LOCAL_ASCENT_END)/(1-LOCAL_ASCENT_END),0,1));
      direction=rotate(arc.direction,arc.radial,pitch*Math.PI/2);
      if(phase.id==='descent')attitude=rotate(scale(arc.direction,-1),arc.radial,pitch*Math.PI/2);
      throttle=!engine?0:phase.id==='descent'?(altitudeKm>.6?1:.55+.45*clamp(altitudeKm/.6,0,1)):1;
      config=phase.id==='descent'?'lm':'ascent';
      // Above the site the CSM is in the picture: in its orbit ahead, its nose on the ascent stage (it tracked the LM).
      if(phase.id==='ascent'&&!local){
        const csm=add(moon,parkingState(plan.lunarReturnParking,ms).relative);config='pair';
        pair={lm:position,csm,lmAttitude:direction,csmAttitude:unit(subtract(position,csm)),focus:0,status:'climb',gapKm:norm(subtract(csm,position))-DOCKED_KM,rangeKm:norm(subtract(csm,position)),rcs:0};
      }
      break;
    }
    case 'surface':position=lunarPoint(plan.site,date,astronomy,plan.elevationKm);local=true;altitudeReference='solo lunar';config='lm';break;
    case 'outbound':case 'inbound':{
      config=phase.id==='outbound'?'stack':'csm';
      position=transferPoint(plan,phase.id,t,astronomy);direction=unit(subtract(transferPoint(plan,phase.id,clamp(t+1e-7,0,1),astronomy),transferPoint(plan,phase.id,clamp(t-1e-7,0,1),astronomy)));
      // Refer to the closer body rather than reporting a misleading lunar altitude near Earth.
      const earthAltitude=norm(position)-EARTH_RADIUS,moonAltitude=norm(subtract(position,moon))-RADIUS_KM;
      altitudeReference=earthAltitude<moonAltitude?'Terra':'Lua';altitudeKm=Math.min(earthAltitude,moonAltitude);break;
    }
    case 'arrival':{
      // Command module alone, heat shield first, in the plasma sheath.
      const e=entryPoint(plan,t,astronomy);position=e.position;altitudeKm=e.altitudeKm;
      direction=unit(subtract(entryPoint(plan,Math.min(1,t+1e-3),astronomy).position,entryPoint(plan,Math.max(0,t-1e-3),astronomy).position));
      attitude=scale(direction,-1);config='cm';plasma=Math.pow(Math.sin(Math.PI*clamp(t/.92,0,1)),.7);break;
    }
    case 'splashdown':{
      const e=splashdownPoint(plan,t,astronomy);position=e.position;altitudeKm=e.altitudeKm;attitude=unit(position);
      direction=unit(subtract(splashdownPoint(plan,Math.min(1,t+1e-3),astronomy).position,splashdownPoint(plan,Math.max(0,t-1e-3),astronomy).position));
      config='cmChutes';chutes=t<.12?'drogue':'main';ocean=true;altitudeReference='mar';break;
    }
  }
  if(!direction)direction=unit(subtract(position,moon));
  if(['loi','tei'].includes(phase.id)){
    const a=clamp(t-.001,0,1),b=clamp(t+.001,0,1),motion=unit(subtract(burnPoint(plan,phase.id,b,astronomy),burnPoint(plan,phase.id,a,astronomy)));
    const blend=phase.id==='loi'?1-u:u;direction=unit(add(scale(direction,1-blend),scale(motion,blend)));
  }
  // Lunar orbit insertion is a braking burn: the service engine points along the motion.
  if(phase.id==='loi')attitude=scale(direction,-1);
  if(!attitude)attitude=direction;
  let localPosition=null,localDirection=null;
  if(local){
    const basis=siteBasis(plan.site),relative=frame.transform(subtract(position,moon)),bodyDirection=frame.transform(attitude);
    localPosition=[dot(relative,basis.east),dot(relative,basis.up)-RADIUS_KM-plan.elevationKm,-dot(relative,basis.north)];
    localDirection=[dot(bodyDirection,basis.east),dot(bodyDirection,basis.up),-dot(bodyDirection,basis.north)];
  }
  if(ocean||pad){localPosition=[0,altitudeKm,0];localDirection=[0,1,0];}
  return {phase:phase.id,label:phase.label,t,date,position,direction,attitude,moon,frame,local,localPosition,localDirection,engine,throttle,config,pair,plasma,chutes,ocean,pad,ignition,orbit,orbitFrom,orbitAt,
    orbitTurns:orbit?clamp((ms-orbit.start)/(orbit.periodSeconds*1000),0,orbit.turns):null,
    altitudeKm:Math.max(0,altitudeKm),altitudeReference,elapsedHours:(ms-plan.launch)/HOUR,distanceKm:norm(moon)};
}
