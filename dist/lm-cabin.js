import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Apollo Operations Handbook, LM-10 vol. I, crew station / panels 1–16;
// NASA TN D-6722, LM display and control subsystem. Procedural, legible approximation.
// https://www.nasa.gov/wp-content/uploads/static/history/alsj/tnD6722LMDisplayControl.pdf
// Metres in buildLM's full frame: +Y up, +Z ladder, +X commander's side. No internal km scale.
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const WINDOWS = [[.30, 4.94, 1.87], [1.11, 4.88, 1.28], [.43, 4.33, 1.57]];
const PANEL_IDS = [1, 2, 3, 4, 5, 6, 8, 11, 16];

function makeAtlas() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2048;
  const c = canvas.getContext('2d'), S = 512;
  const text = (s, x, y, size = 11, color = '#e1dfd0', align = 'center') => { c.fillStyle = color; c.font = `${size}px monospace`; c.textAlign = align; c.fillText(s, x, y); };
  const line = (x, y, xx, yy, color = '#b3b3a6', width = 1) => { c.strokeStyle = color; c.lineWidth = width; c.beginPath(); c.moveTo(x, y); c.lineTo(xx, yy); c.stroke(); };
  const gauge = (x, y, r, label, value, ball = false) => {
    c.fillStyle = '#090b0b'; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#a5a99f'; c.lineWidth = 5; c.stroke();
    if (ball) {
      c.save(); c.beginPath(); c.arc(x, y, r - 8, 0, Math.PI * 2); c.clip(); c.translate(x, y); c.rotate(-.12);
      c.fillStyle = '#647f87'; c.fillRect(-r, -r, r * 2, r); c.fillStyle = '#705c48'; c.fillRect(-r, 0, r * 2, r);
      for (let i = -3; i <= 3; i++) { line(-r * .45, i * r * .19, r * .45, i * r * .19, '#f1eee1', 2); if (i) text(String(Math.abs(i * 10)), r * .65, i * r * .19 + 4, 10); }
      line(0, -r, 0, r, '#e4e4d8', 1); c.restore(); line(x - r * .55, y, x - 7, y, '#e8ba43', 4); line(x + 7, y, x + r * .55, y, '#e8ba43', 4);
    } else {
      for (let i = 0; i <= 10; i++) { const a = Math.PI * (.75 + i * .15); line(x + Math.cos(a) * r * .69, y + Math.sin(a) * r * .69, x + Math.cos(a) * r * .84, y + Math.sin(a) * r * .84); }
      const a = Math.PI * 1.72; line(x, y, x + Math.cos(a) * r * .72, y + Math.sin(a) * r * .72, '#eee9d1', 3); c.fillStyle = '#a5a99f'; c.beginPath(); c.arc(x, y, 4, 0, 7); c.fill(); text(value, x, y + r * .52, 13);
    }
    text(label, x, y + r + 19, 13);
  };
  const tape = (x, y, label, units, value) => {
    c.fillStyle = '#090b0b'; c.fillRect(x, y, 57, 180); c.strokeStyle = '#c3c5b6'; c.strokeRect(x, y, 57, 180);
    for (let i = 0; i < 15; i++) { const yy = y + 9 + i * 11.3; line(x + 4, yy, x + (i % 5 ? 13 : 23), yy); if (i % 5 === 0) text(String(100 - i * 5), x + 36, yy + 4, 11); }
    c.strokeStyle = '#f2e1b1'; c.lineWidth = 2; c.strokeRect(x - 3, y + 75, 63, 25); text(value, x + 29, y + 93, 17); text(label, x + 29, y - 13, 12); text(units, x + 29, y + 198, 10);
  };
  const legends = {
    3: ['RADAR', 'ENGINE ARM', 'DESCENT', 'ASCENT', 'ABORT', 'STAGE', 'EXTERIOR LT', 'FLOOD', 'TRACK MODE', 'RNDZ RADAR', 'LANDING RADAR', 'GUIDANCE'],
    5: ['ECS', 'CABIN REPRESS', 'OXYGEN', 'SUIT FAN', 'GLYCOL', 'COOLANT', 'WATER', 'SUIT ISOL', 'PRESS REG', 'CABIN DUMP', 'BATTERY', 'COMM'],
    6: ['COMMUNICATIONS', 'VHF A', 'VHF B', 'S BAND', 'XMTR', 'RECEIVER', 'AUDIO', 'VOICE', 'TELEMETRY', 'UP DATA', 'ANTENNA', 'RANGE'],
    8: ['FLIGHT CONTROL', 'MODE CONTROL', 'ATT HOLD', 'AUTO', 'RATE / ERR', 'RCS', 'THROTTLE', 'DEADBAND', 'TRANSLATION', 'ACA', 'TTCA', 'BALANCE']
  };
  PANEL_IDS.forEach((id, tile) => {
    c.save(); c.translate((tile % 4) * S, Math.floor(tile / 4) * S);
    c.fillStyle = '#535b5c'; c.fillRect(0, 0, S, S);
    // Painted aluminium, engraved white legends and screw heads; no photographic imagery.
    c.strokeStyle = '#a4aaa5'; c.lineWidth = 2; c.strokeRect(8, 8, 496, 496);
    for (const x of [17, 495]) for (const y of [17, 495]) { c.fillStyle = '#afb1a7'; c.beginPath(); c.arc(x, y, 5, 0, 7); c.fill(); line(x - 3, y + 2, x + 3, y - 2, '#353b3a'); }
    text(`PANEL ${id}`, 256, 30, 13); line(20, 42, 492, 42);
    if (id === 1 || id === 2) {
      gauge(143, 155, 78, 'ATTITUDE / FDAI', '', true);
      if (id === 1) { tape(278, 86, 'ALTITUDE', 'FEET', '0060'); tape(359, 86, 'ALT RATE', 'FT / SEC', '00'); gauge(136, 355, 55, 'X POINTER', '0'); gauge(295, 360, 48, 'RANGE / RATE', '027'); gauge(421, 360, 38, 'THRUST / WT', '1.0'); }
      else { gauge(330, 137, 47, 'RCS PRESS', '280'); gauge(435, 137, 47, 'OXID', '170'); gauge(330, 276, 47, 'CABIN PSI', '4.8'); gauge(435, 276, 47, 'SUIT PSI', '3.7'); gauge(146, 357, 55, 'ECS TEMP', '68'); text('OXYGEN   WATER   GLYCOL', 351, 402, 12); }
      ['GUID CONT', 'RATE SCALE', 'ATTITUDE', 'DES QTY', 'RCS QTY'].forEach((s, i) => text(s, 62 + i * 98, 474, 9));
    } else if (id === 4) {
      text('APOLLO GUIDANCE COMPUTER', 256, 57, 16); c.fillStyle = '#101b17'; c.fillRect(69, 76, 374, 229); c.strokeStyle = '#c7ccba'; c.strokeRect(69, 76, 374, 229);
      text('PROG      VERB      NOUN', 256, 103, 15, '#6abc84'); text('63        06        60', 256, 137, 28, '#8beca6');
      ['+ 0 0 0 6 0', '+ 0 0 0 0 0', '+ 0 0 1 2 7'].forEach((s, i) => text(s, 265, 184 + i * 46, 31, '#8beca6'));
      ['COMP ACTY', 'UPLINK ACTY', 'NO ATT', 'STBY', 'KEY REL', 'OPR ERR'].forEach((s, i) => text(s, 37, 116 + i * 27, 8, i === 0 ? '#cce1a0' : '#9c9e8d'));
      const keys = ['VERB','NOUN','+','7','8','9','CLR','-','4','5','6','PRO','0','1','2','3','KEY REL','ENTR','RSET',''];
      keys.forEach((s, i) => { const x = 80 + i % 5 * 73, y = 324 + Math.floor(i / 5) * 30; c.fillStyle = '#bcbdb0'; c.fillRect(x, y, 61, 24); text(s, x + 30, y + 16, 10, '#172321'); });
      c.fillStyle = '#101b17'; c.fillRect(75, 455, 362, 35); text('MET  102:45:40    EVT  00:27', 256, 480, 18, '#9dceaa');
    } else if (id === 11 || id === 16) {
      text(id === 11 ? 'CDR CIRCUIT BREAKERS' : 'LMP CIRCUIT BREAKERS', 256, 61, 14);
      const systems = ['DC BUS','RCS A','RCS B','PGNS','AGS','RADAR','ECS','COMM','LIGHTS','INST','HEAT','AC BUS'];
      for (let row = 0; row < 10; row++) for (let col = 0; col < 20; col++) {
        const x = 23 + col * 24.5, y = 95 + row * 40;
        text(systems[(row + Math.floor(col / 3)) % systems.length], x, y - 12, 5); text(String([2, 5, 10, 15, 20][(row + col) % 5]), x, y + 12, 5);
      }
    } else {
      const labels = legends[id];
      for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
        const x = 67 + col * 126, y = 98 + row * 101; text(labels[(row * 4 + col) % labels.length], x, y - 19, 10); text('ON', x, y + 6, 8); text('OFF', x, y + 49, 8); line(x - 50, y + 67, x + 50, y + 67, '#92988f');
        if (row === 2) { c.fillStyle = '#19211e'; c.fillRect(x - 20, y + 18, 40, 18); text(col % 2 ? 'CLOSED' : 'OPEN', x, y + 31, 7); }
      }
    }
    c.restore();
  });
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
  return texture;
}

// The cabin's skin: painted aluminium panels (the LM interior was a medium grey-green), seams, rivet rows, a few
// stencilled placards and the wear of a working cabin. Applied by position in metres (one tile = 0.9 m), so boxes
// of any size share it without stretching.
function makeSkin() {
  const n = 1024, c = document.createElement('canvas'); c.width = c.height = n; const g = c.getContext('2d');
  let seed = 9; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  g.fillStyle = '#6f756f'; g.fillRect(0, 0, n, n);
  for (let i = 0; i < 1400; i++) { const x = rnd() * n, y = rnd() * n, r = 8 + rnd() * 90; g.fillStyle = `rgba(${rnd() < .55 ? '48,52,50' : '140,146,140'},${.03 + rnd() * .06})`; g.beginPath(); g.ellipse(x, y, r, r * (.4 + rnd() * .6), rnd() * 3, 0, 7); g.fill(); }
  // Access panels of varied sizes, a shade darker or lighter, then the main panels 512 px (45 cm) with their seams.
  for (let i = 0; i < 7; i++) { const w = 80 + rnd() * 260, h = 60 + rnd() * 200, x = rnd() * (n - w), y = rnd() * (n - h); g.fillStyle = `rgba(${rnd() < .5 ? '40,44,42,.22' : '170,176,170,.14'})`; g.fillRect(x, y, w, h); g.strokeStyle = 'rgba(25,28,27,.5)'; g.lineWidth = 2; g.strokeRect(x, y, w, h); }
  for (let k = 0; k <= 2; k++) for (const vertical of [true, false]) {
    const p = k * 512; g.fillStyle = 'rgba(25,28,27,.55)'; vertical ? g.fillRect(p - 2, 0, 3, n) : g.fillRect(0, p - 2, n, 3);
    g.fillStyle = 'rgba(210,214,208,.25)'; vertical ? g.fillRect(p + 1, 0, 1, n) : g.fillRect(0, p + 1, n, 1);
    for (let t = 10; t < n; t += 34) for (const o of [-14, 14]) {
      const x = vertical ? p + o : t, y = vertical ? t : p + o;
      g.fillStyle = 'rgba(40,43,41,.6)'; g.beginPath(); g.arc(x, y, 2.6, 0, 7); g.fill(); g.fillStyle = 'rgba(205,208,200,.5)'; g.beginPath(); g.arc(x - .7, y - .7, 1.2, 0, 7); g.fill();
    }
  }
  const placards = ['STOWAGE', 'O2', 'H2O', 'LiOH', 'CAUTION', 'DO NOT STEP', 'PRESS TO OPEN', 'ECS', 'UTILITY LIGHT', 'FIRE EXT'];
  g.font = 'bold 15px monospace'; g.textAlign = 'center';
  for (let i = 0; i < 4; i++) { const x = 40 + rnd() * (n - 80), y = 30 + rnd() * (n - 60), s = placards[i % placards.length], w = s.length * 10 + 16;
    g.fillStyle = 'rgba(232,230,214,.85)'; g.fillRect(x - w / 2, y - 12, w, 20); g.strokeStyle = 'rgba(30,30,30,.7)'; g.strokeRect(x - w / 2, y - 12, w, 20); g.fillStyle = '#1d1d1b'; g.fillText(s, x, y + 3); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; return t;
}
// Floor: dark grey with the square Velcro pads the crew's boots held on to.
function makeFloor() {
  const n = 512, c = document.createElement('canvas'); c.width = c.height = n; const g = c.getContext('2d');
  g.fillStyle = '#3b3e3c'; g.fillRect(0, 0, n, n);
  for (let y = 16; y < n; y += 128) for (let x = 16; x < n; x += 128) { g.fillStyle = '#26282a'; g.fillRect(x, y, 96, 96); for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(80,82,84,${Math.random() * .3})`; g.fillRect(x + Math.random() * 96, y + Math.random() * 96, 1, 1); } }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; return t;
}
// Projects a map by the dominant axis of the object-space normal (geometry is baked in cabin metres).
function boxMapped(material, texture, tile) {
  material.map = texture;
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCabP;\nvarying vec3 vCabN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCabP = position; vCabN = normal;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vCabP;\nvarying vec3 vCabN;')
      .replace('#include <map_fragment>', `vec3 cabA = abs(vCabN); vec2 cabUv = cabA.x > cabA.y && cabA.x > cabA.z ? vCabP.zy : cabA.y > cabA.z ? vCabP.xz : vCabP.xy;
diffuseColor *= texture2D(map, cabUv / ${tile.toFixed(3)});`);
  };
  material.customProgramCacheKey = () => `cabin-box-${tile}`;
  return material;
}
// A soft grey surround as the cabin's ambient: the floods bouncing off the light walls (no black corners).
function cabinAmbient() {
  const faces = [];
  for (let f = 0; f < 6; f++) { const c = document.createElement('canvas'); c.width = c.height = 4; const g = c.getContext('2d'); g.fillStyle = f === 2 ? '#8a8e8a' : f === 3 ? '#3e403f' : '#6b6f6c'; g.fillRect(0, 0, 4, 4); faces.push(c); }
  const t = new THREE.CubeTexture(faces); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; return t;
}

// ambient: a ready PMREM texture to use instead of the cube below (the caller owns it): the cube is converted on its
// first draw, compiling PMREM's shaders for its 4 px size there and then (a stall of seconds on Windows).
export function buildLMCabin({ exterior = null, worldScale = 1, lights = true, ambient: given = null } = {}) {
  const group = new THREE.Group(); group.name = 'LM crew cabin';
  const texture = makeAtlas(), skin = makeSkin(), floorMap = makeFloor(), ambient = given || cabinAmbient(), materials = [], geometries = [], buckets = new Map(), instances = new Map();
  const mat = (color, roughness = .72, metalness = .1, extra = {}) => { const m = new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra }); materials.push(m); return m; };
  const wall = boxMapped(mat(0xffffff, .78, .12), skin, .9), trim = mat(0x242b29, .6, .25), metal = mat(0xa8aaa1, .43, .6), black = mat(0x131917), white = mat(0xc9c9b5), red = mat(0x923728), fabric = mat(0xd9d3c4, .97, 0);
  const floor = boxMapped(mat(0xffffff, .9, .05), floorMap, .55), beta = mat(0xe6e0d0, .96, 0), hose = mat(0x2b4f8c, .6, 0), hoseRed = mat(0x8c2b2b, .6, 0), cableW = mat(0xb8b4a6, .7, 0);
  const face = mat(0xffffff, .78, .06, { map: texture, emissiveMap: texture, emissive: 0xffffff, emissiveIntensity: .09 });
  const display = mat(0xffffff, .76, 0, { map: texture, emissiveMap: texture, emissive: 0xffffff, emissiveIntensity: .38 });
  const matrix = (position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) => new THREE.Matrix4().compose(V(...position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), V(...scale));
  const batch = (geometry, material, transform = new THREE.Matrix4()) => { geometry.applyMatrix4(transform); if (!buckets.has(material)) buckets.set(material, []); buckets.get(material).push(geometry); return geometry; };
  const box = (size, position, material = wall, rotation) => batch(new THREE.BoxGeometry(...size), material, matrix(position, rotation));
  const beam = (a, b, radius = .018, material = metal) => {
    a = Array.isArray(a) ? V(...a) : a; b = Array.isArray(b) ? V(...b) : b;
    const d = b.clone().sub(a), transform = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(.5), new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.clone().normalize()), V(1, 1, 1));
    batch(new THREE.CylinderGeometry(radius, radius, d.length(), 7), material, transform);
  };
  const put = (kind, material, geometry, transform) => {
    const key = `${kind}:${material.uuid}`;
    if (!instances.has(key)) instances.set(key, { material, geometry, matrices: [] }); else geometry.dispose();
    instances.get(key).matrices.push(transform);
  };
  const at = (base, p, r = [0, 0, 0], s = [1, 1, 1]) => base.clone().multiply(matrix(p, r, s));

  // LM forward pressure cabin: approximately 2.3 m usable width. Descent deck remains outside.
  box([2.38, .065, 3.4], [.04, 3.16, .93], floor);
  box([.065, 2.2, 3.4], [1.265, 4.26, .93]); box([.065, 2.2, 3.4], [-1.185, 4.26, .93]);
  box([2.38, 2.22, .055], [.04, 4.28, -.80]);
  box([.42, .052, 1.7], [-.94, 5.34, .12]); box([.95, .052, 1.7], [.755, 5.34, .12]);
  box([.58, .052, .78], [-.39, 5.34, -.36]); box([.58, .052, .32], [-.39, 5.34, .93]);
  // Overhead CDR docking window; the rectangle is a genuine hole, without glass or an opaque roof.
  const docking = [[-.70, 5.34, .05], [-.08, 5.34, .05], [-.08, 5.34, .72], [-.70, 5.34, .72]];
  // CDR is +X in NASA's +Z-forward model, so mirror the docking cutout to the CDR side.
  for (const p of docking) p[0] = .08 - p[0];
  // Rebuild roof strips around its opening with a common centreline at x=.04.
  const roofParts = buckets.get(wall).splice(-4); roofParts.forEach(g => g.dispose());
  box([.42, .052, 1.7], [1.02, 5.34, .12]); box([.95, .052, 1.7], [-.675, 5.34, .12]); box([2.45, .052, 1.62], [.04, 5.345, 1.79]);
  box([.62, .052, .78], [.47, 5.34, -.36]); box([.62, .052, .32], [.47, 5.34, .93]);
  docking.forEach((p, i) => beam(p, docking[(i + 1) % 4], .038, trim));
  const windowCorners = {};
  for (const side of [1, -1]) {
    const corners = WINDOWS.map(p => V(side === 1 ? p[0] : .08 - p[0], p[1], p[2])); windowCorners[side === 1 ? 'cdr' : 'lmp'] = corners;
    const origin = corners[0], u = corners[1].clone().sub(origin).normalize(), offset = corners[2].clone().sub(origin), v = offset.clone().addScaledVector(u, -offset.dot(u)).normalize(), n = u.clone().cross(v).normalize();
    const w = corners[1].distanceTo(origin), tx = offset.dot(u), ty = offset.dot(v);
    // The window wall: a plane parallel to the pane, 10 cm outboard, that closes the cabin front on this side. Its
    // aperture is the pane seen from this crew member's eye; the plane is clipped at the centre line, floor, roof and
    // side wall, so it never crosses the console. Double-sided: it casts the window-frame shadows inside.
    const eye = side === 1 ? V(.62, 4.84, .84) : V(-.54, 4.84, .84);
    const nn = n.clone(); if (nn.dot(eye.clone().sub(origin)) > 0) nn.negate();
    const o = origin.clone().addScaledVector(nn, .10), toPlane = q => [q.clone().sub(o).dot(u), q.clone().sub(o).dot(v)];
    const aperture = corners.map(p => { const d = p.clone().sub(eye), t = o.clone().sub(eye).dot(nn) / d.dot(nn); return eye.clone().addScaledVector(d, t); });
    // A large square in the plane, clipped by half-spaces (Sutherland-Hodgman in 3-D).
    let poly = [[-3, -3], [3, -3], [3, 3], [-3, 3]].map(([a, b]) => o.clone().addScaledVector(u, a).addScaledVector(v, b));
    const clip = (axis, limit, keepBelow) => {
      const inside = q => keepBelow ? q[axis] <= limit : q[axis] >= limit, out = [];
      poly.forEach((a, i) => { const b = poly[(i + 1) % poly.length], ia = inside(a), ib = inside(b);
        if (ia) out.push(a);
        if (ia !== ib) out.push(a.clone().lerp(b, (limit - a[axis]) / (b[axis] - a[axis])));
      });
      poly = out;
    };
    clip('x', .04, side !== 1); clip('x', side === 1 ? 1.265 : -1.185, side === 1); clip('y', 3.19, false); clip('y', 5.33, true); clip('z', 2.6, true);
    const shell = new THREE.Shape(); poly.forEach((q, i) => i ? shell.lineTo(...toPlane(q)) : shell.moveTo(...toPlane(q))); shell.closePath();
    const hole = new THREE.Path(); aperture.forEach((q, i) => i ? hole.lineTo(...toPlane(q)) : hole.moveTo(...toPlane(q))); hole.closePath(); shell.holes.push(hole);
    const basis = new THREE.Matrix4().makeBasis(u, v, u.clone().cross(v)).setPosition(o);
    const shellGeometry = new THREE.ShapeGeometry(shell); shellGeometry.clearGroups();
    wall.side = THREE.DoubleSide; batch(shellGeometry, wall, basis);
    // Window reveal: the pane to the aperture, a short tunnel of the frame colour.
    for (let i = 0; i < 3; i++) {
      const a = corners[i], b = corners[(i + 1) % 3], c = aperture[(i + 1) % 3], d = aperture[i], g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([...a.toArray(), ...b.toArray(), ...c.toArray(), ...a.toArray(), ...c.toArray(), ...d.toArray()], 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(12).fill(0), 2)); g.setIndex([0, 1, 2, 3, 4, 5]); g.computeVertexNormals();
      batch(g, trim);
    }
    corners.forEach((p, i) => { beam(p, corners[(i + 1) % 3], .043, trim); beam(p.clone().addScaledVector(n, .025), corners[(i + 1) % 3].clone().addScaledVector(n, .025), .018, metal); });
    for (let i = 0; i < 3; i++) for (let k = 0; k < 9; k++) {
      const p = corners[i].clone().lerp(corners[(i + 1) % 3], (k + .5) / 9).addScaledVector(n, .043);
      put('frame bolt', metal, new THREE.SphereGeometry(.006, 6, 4), matrix(p.toArray()));
    }
  }
  // Forward hatch lies below the central instrument stack, with locking wheel and handle.
  box([.69, .66, .07], [.04, 3.54, 1.54], trim, [-.13, 0, 0]); box([.58, .55, .035], [.04, 3.55, 1.491], wall, [-.13, 0, 0]);
  batch(new THREE.TorusGeometry(.11, .012, 5, 18), metal, matrix([.04, 3.55, 1.456]));
  beam([-.08, 3.55, 1.45], [.16, 3.55, 1.45], .013); beam([.04, 3.44, 1.45], [.04, 3.66, 1.45], .013);
  // Centre console structure between the windows: the instrument stack stands on it, above the hatch.
  box([.40, .95, .22], [.04, 4.33, 1.86], trim); box([.58, .05, .42], [.04, 3.87, 1.46], metal);
  // Ascent engine cover intrudes into the aft floor; no seats were carried in the LM.
  batch(new THREE.CylinderGeometry(.42, .61, .57, 10), fabric, matrix([.04, 3.48, -.36])); box([1.04, .13, .65], [.04, 3.45, -.53], fabric);

  function panel(id, width, height, position, rotation = [0, 0, 0]) {
    const base = matrix(position, rotation), tile = PANEL_IDS.indexOf(id), geometry = new THREE.PlaneGeometry(width, height), uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (tile % 4 + uv.getX(i)) / 4, 1 - (Math.floor(tile / 4) + 1 - uv.getY(i)) / 4);
    batch(new THREE.BoxGeometry(width + .025, height + .025, .032), trim, at(base, [0, 0, -.02])); batch(geometry, id === 4 ? display : face, base);
    const local = (x, y, z = .018) => at(base, [x * width, y * height, z]);
    if (id === 11 || id === 16) {
      // 200 pull-type circuit breakers per overhead panel, black knobs with white current bands.
      for (let row = 0; row < 10; row++) for (let col = 0; col < 20; col++) {
        const x = (23 + col * 24.5) / 512 - .5, y = .5 - (95 + row * 40) / 512;
        put('breaker', black, new THREE.CylinderGeometry(.006, .007, .021, 6).rotateX(Math.PI / 2), local(x, y, .020));
        put('breaker band', white, new THREE.CylinderGeometry(.0063, .0063, .003, 6).rotateX(Math.PI / 2), local(x, y, .027));
      }
    } else if (id === 1 || id === 2) {
      for (let i = 0; i < 5; i++) {
        put('rotary', black, new THREE.CylinderGeometry(.012, .014, .019, 8).rotateX(Math.PI / 2), local(-.38 + i * .19, -.43));
        put('index', white, new THREE.BoxGeometry(.0025, .012, .002), at(local(-.38 + i * .19, -.43, .029), [0, .003, 0]));
      }
    } else if (id === 4) {
      // Key faces are atlas artwork; their shallow relief catches the modest flood illumination.
      for (let row = 0; row < 4; row++) for (let col = 0; col < 5; col++) {
        const p = [(110 + col * 73) / 512 - .5, .5 - (336 + row * 30) / 512];
        put('key rim', trim, new THREE.BoxGeometry(width * .129, height * .052, .004), local(...p, -.002));
      }
    } else {
      for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
        const x = (67 + col * 126) / 512 - .5, y = .5 - (127 + row * 101) / 512;
        put('toggle base', black, new THREE.CylinderGeometry(.010, .010, .008, 8).rotateX(Math.PI / 2), local(x, y, .009));
        put('toggle lever', metal, new THREE.CylinderGeometry(.0028, .0033, .030, 5).rotateX(.70), local(x, y, .022));
        if ((row + col + id) % 4 === 0) {
          put('switch guard', red, new THREE.BoxGeometry(.029, .007, .030), local(x, y + .035, .023));
          for (const s of [-1, 1]) put('guard side', red, new THREE.BoxGeometry(.004, .029, .030), at(local(x, y, .023), [s * .014, .003, 0]));
        }
        if (row === 2) {
          put('talkback frame', metal, new THREE.BoxGeometry(width * .085, height * .043, .006), local(x, y - .025, .004));
          for (let stripe = 0; stripe < 4; stripe++) put('barber pole', stripe % 2 ? black : white, new THREE.BoxGeometry(width * .014, height * .026, .003), at(local(x, y - .025, .009), [(stripe - 1.5) * width * .017, 0, 0], [0, 0, -.45]));
        }
      }
    }
    return base;
  }
  // Instruments sit below the triangular sight lines, facing aft toward the standing crew.
  panel(1, .50, .42, [.24, 4.64, 1.44], [-.12, Math.PI - .42, 0]);
  panel(2, .50, .42, [-.16, 4.64, 1.44], [-.12, Math.PI + .42, 0]);
  panel(3, .56, .26, [.04, 4.27, 1.43], [-.42, Math.PI, 0]);
  panel(4, .30, .40, [.04, 4.00, 1.30], [-.62, Math.PI, 0]);
  panel(8, .64, .49, [1.10, 4.43, .42], [0, -Math.PI / 2 - .10, 0]);
  panel(5, .64, .49, [-1.02, 4.43, .42], [0, Math.PI / 2 + .10, 0]);
  panel(6, .64, .37, [-1.02, 4.89, .30], [0, Math.PI / 2 + .10, 0]);
  panel(11, .88, .42, [.68, 5.17, .06], [Math.PI / 3, Math.PI, 0]);
  panel(16, .88, .42, [-.60, 5.17, .06], [Math.PI / 3, Math.PI, 0]);
  for (const sx of [-1, 1]) {
    const cx = sx > 0 ? .65 : -.57;
    for (const dx of [-.25, .25]) {
      box([.075, .055, .43], [cx + dx, 3.93, .62], fabric, [.06, 0, 0]); beam([cx + dx, 3.84, .38], [cx + dx, 3.62, .91], .017, metal);
      // Crew restraint cables, routed down to the floor and clear of each window aperture.
      const curve = new THREE.CatmullRomCurve3([V(cx + dx, 3.97, .36), V(cx + dx * .8, 3.61, .41), V(cx + dx * 1.2, 3.24, .31)]);
      batch(new THREE.TubeGeometry(curve, 12, .006, 5, false), black);
    }
    // ACA right-hand pistol grip and left-hand TTCA translation/throttle T-handle.
    const right = cx - .23, left = cx + .23;
    beam([right, 3.93, .82], [right, 4.11, .84], .025, black); box([.048, .13, .065], [right, 4.16, .83], black, [.26, 0, 0]); box([.018, .025, .012], [right, 4.20, .79], red);
    beam([left, 3.93, .82], [left, 4.08, .86], .018); beam([left - .07, 4.10, .86], [left + .07, 4.10, .86], .018, black);
  }
  // --- Working-cabin detail (LM-10 Operations Handbook crew-station drawings) ---------------------------------------
  // Structural frames on the side walls and the ceiling every 32 cm.
  for (let z = -.62; z <= 1.0; z += .32) for (const x of [1.225, -1.145]) box([.035, 2.05, .05], [x, 4.22, z], trim);
  for (let z = -.62; z <= .9; z += .32) box([2.3, .04, .05], [.04, 5.30, z], trim);
  // Cable bundles along the upper side walls, sleeved and clamped; ECS hoses (suit loop blue, return red) to the stations.
  for (const [x, side] of [[1.18, 1], [-1.1, -1]]) {
    for (const [dy, m, rad] of [[0, black, .016], [.05, cableW, .011], [-.045, black, .012]]) {
      const curve = new THREE.CatmullRomCurve3([V(x, 5.05 + dy, -.7), V(x - side * .02, 5.0 + dy, -.1), V(x, 5.08 + dy, .5), V(x - side * .03, 4.95 + dy, 1.05)]);
      batch(new THREE.TubeGeometry(curve, 24, rad, 6, false), m);
    }
    for (let z = -.6; z <= 1.0; z += .26) box([.03, .13, .025], [x - side * .012, 5.03, z], metal);
    for (const [m, dz] of [[hose, 0], [hoseRed, .09]]) {
      const curve = new THREE.CatmullRomCurve3([V(x - side * .05, 4.1, -.55 + dz), V(x - side * .25, 3.75, -.1 + dz), V(x - side * .45, 3.9, .35 + dz), V(x - side * .55, 4.25, .55 + dz)]);
      batch(new THREE.TubeGeometry(curve, 20, .028, 8, false), m);
    }
  }
  // Alignment Optical Telescope (AOT): the barrel down from the cabin roof between the crew, its eyepiece and knobs.
  beam([.04, 5.32, 1.22], [.04, 4.98, 1.08], .085, trim); beam([.04, 5.0, 1.09], [.04, 4.9, 1.02], .055, black);
  box([.16, .1, .12], [.04, 4.88, .98], black, [-.4, 0, 0]);
  for (const dx of [-.11, .11]) { const g = new THREE.CylinderGeometry(.026, .026, .03, 12).rotateZ(Math.PI / 2); batch(g, metal, matrix([.04 + dx, 5.06, 1.12])); }
  // Overhead (docking) hatch in the ceiling aft: 81 cm, its rim, the dished cover and the handle.
  { const ring = new THREE.TorusGeometry(.42, .035, 8, 40).rotateX(Math.PI / 2); batch(ring, metal, matrix([.04, 5.31, -.3]));
    const lid = new THREE.CylinderGeometry(.4, .4, .03, 40); batch(lid, wall, matrix([.04, 5.33, -.3]));
    beam([-.18, 5.27, -.3], [.26, 5.27, -.3], .016, black); box([.05, .06, .05], [-.18, 5.29, -.3], black); box([.05, .06, .05], [.26, 5.29, -.3], black); }
  // Beta-cloth stowage: soft off-white bags on the aft bulkhead and the side walls, with their snaps and straps.
  const bag = (size, position, rotation = [0, 0, 0]) => {
    const g = new THREE.BoxGeometry(...size, 4, 4, 4), q = g.attributes.position, v = V(0, 0, 0);
    for (let i = 0; i < q.count; i++) { v.fromBufferAttribute(q, i); const k = 1 + .06 * Math.sin(v.x * 23 + v.y * 17) * Math.cos(v.z * 19); v.x *= k; v.y *= 1 - .04 * Math.abs(Math.sin(v.x * 13)); q.setXYZ(i, v.x, v.y, v.z); }
    g.computeVertexNormals(); batch(g, beta, matrix(position, rotation));
    box([size[0] * 1.02, .025, size[2] * 1.04], [position[0], position[1] + size[1] * .22, position[2]], black, rotation);
  };
  bag([.55, .42, .2], [.6, 4.55, -.68]); bag([.5, .36, .2], [-.5, 4.6, -.68]); bag([.42, .3, .18], [.6, 4.12, -.68]);
  bag([.2, .34, .44], [1.12, 3.75, -.35]); bag([.2, .3, .4], [-1.04, 3.8, -.35]);
  // Window panes: a faint reflection on the inner glass (the LM's windows were triple-paned with a heater film).
  const glass = mat(0x9aa8b4, .05, 0, { transparent: true, opacity: .07, depthWrite: false });
  for (const key of ['cdr', 'lmp']) {
    const c = windowCorners[key], g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...c[0].toArray(), ...c[1].toArray(), ...c[2].toArray()], 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2)); g.setIndex([0, 1, 2]); g.computeVertexNormals();
    const pane = new THREE.Mesh(g, glass); pane.renderOrder = 3; pane.name = 'Window pane'; group.add(pane); geometries.push(g);
  }
  // Small handrails and aft stowage soften the otherwise flat pressure vessel.
  for (const x of [-.95, 1.03]) { beam([x, 4.63, -.67], [x, 5.02, -.67], .016); box([.30, .56, .13], [x * .76, 4.04, -.66], fabric); }
  for (const m of materials) if (m.isMeshStandardMaterial && m !== glass) { m.envMap = ambient; m.envMapIntensity = .55; }
  for (const [material, parts] of buckets) {
    const geometry = mergeGeometries(parts, false); parts.forEach(g => g.dispose());
    const mesh = new THREE.Mesh(geometry, material); mesh.name = 'Cabin structure'; mesh.castShadow = mesh.receiveShadow = true; group.add(mesh); geometries.push(geometry);
  }
  for (const { material, geometry, matrices } of instances.values()) {
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length); matrices.forEach((m, i) => mesh.setMatrixAt(i, m)); mesh.instanceMatrix.needsUpdate = true;
    mesh.name = 'Cabin repeated hardware'; mesh.castShadow = mesh.receiveShadow = true; mesh.computeBoundingSphere(); group.add(mesh); geometries.push(geometry);
  }
  if (lights) {
    // Three's punctual light intensity/range use WORLD units, even when parented to a scaled LM.
    const scale = Number.isFinite(worldScale) && worldScale > 0 ? worldScale : 1;
    // three.js clamps a point light's falloff at 0.1 scene units: in a km scene the whole cabin sits inside that
    // clamp (falloff fixed at 100), so the intensity is set for a typical 0.5 m throw instead of scaled by scale².
    const k = scale === 1 ? 1 : 1 / (.5 * .5 * 100);
    for (const x of [.79, -.71]) { const light = new THREE.PointLight(0xfff4e8, 1.1 * k, 3.2 * scale, 2); light.position.set(x, 5.11, .78); group.add(light); }
    const console_ = new THREE.PointLight(0xfff1dc, .5 * k, 1.6 * scale, 2); console_.position.set(.04, 4.95, 1.05); group.add(console_);
    const dsky = new THREE.PointLight(0x75e9a0, .02 * k, 1.1 * scale, 2); dsky.position.set(.04, 4.12, 1.12); group.add(dsky);
  }
  const hideForInterior = [];
  if (exterior?.userData.ascent) exterior.userData.ascent.traverse(o => {
    // From inside, the whole ascent-stage shell goes: its inner faces cross the cabin (the hull between the windows
    // is a solid wedge in the NASA model). The cabin's own walls close the volume and cast the window shadows.
    if (o.isMesh && !o.userData.plumePart && !/plume|exhaust/i.test(o.name)) hideForInterior.push(o);
  });
  const oldVisibility = new Map();
  function setInterior(enabled = true) {
    for (const node of hideForInterior) {
      if (enabled) { if (!oldVisibility.has(node)) oldVisibility.set(node, node.visible); node.visible = false; }
      else if (oldVisibility.has(node)) { node.visible = oldVisibility.get(node); oldVisibility.delete(node); }
    }
  }
  const eyes = { cdr: V(.62, 4.84, .84), lmp: V(-.54, 4.84, .84) }, lookDir = V(0, -.30, 1).normalize();
  group.userData.frame = { units: 'metres', forward: '+Z', up: '+Y', cdrSide: '+X', eyeHeight: 4.87 };
  group.userData.windowCorners = windowCorners;
  return { group, eyes, lookDir, hideForInterior, setInterior, dispose() { setInterior(false); group.removeFromParent(); geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); texture.dispose(); skin.dispose(); floorMap.dispose(); if (!given) ambient.dispose(); } };
}
