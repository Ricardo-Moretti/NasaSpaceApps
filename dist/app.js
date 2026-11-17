import { sites } from './sites.js';
import { Terrain, evaluate, ephemeris, longestRun, clamp, RADIUS_KM, AU_KM } from './model.js';
import { LunarScene } from './scene.js';
import { MissionUI } from './mission.js';
import { t, getLang, addDictionary, bindLanguageSwitch, onLangChange, number, signedDegrees, utcDate } from './i18n.js';
import { createGuide } from './guide.js';

const SHORT = { shackleton: 'Shackleton', malapert: 'Malapert', degerlache: 'de Gerlache', nobile: 'Nobile', haworth: 'Haworth' };
addDictionary({ pt: { 'dir.S': 'S', 'dir.W': 'O', 'dir.E': 'L' }, en: { 'dir.S': 'S', 'dir.W': 'W', 'dir.E': 'E' } });

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const data = path => new URL(path, import.meta.url);
const astronomy = window.Astronomy;
// v2: exploring a site no longer adds it to the comparison, so older saved selections start fresh.
const STORE = 'horisite-state-v2';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const siteName = s => t(`site.${s.id}`);
const coords = s => `${number(Math.abs(s.lat), 2)}° ${t('dir.S')} · ${number(Math.abs(s.lon), 2)}° ${s.lon < 0 ? t('dir.W') : t('dir.E')}`;
const degrees = n => `${number(n, 1)}°`;
const compass = az => t('compass8').split(',')[Math.round((((az % 360) + 360) % 360) / 45) % 8];
const RAD = Math.PI / 180;
// Great-circle distance between two sites on the Moon, km.
const surfaceKm = (a, b) => { const c = Math.sin(a.lat * RAD) * Math.sin(b.lat * RAD) + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((a.lon - b.lon) * RAD); return RADIUS_KM * Math.acos(clamp(c, -1, 1)); };
const FOLDS = 'horisite-folds';

const state = { selected: ['shackleton'], primary: 'shackleton', view: 'terrain', heightM: 2, panel: 'tracking', date: new Date(), window: null, readingLight: false, psr: false };
const terrains = new Map();
let metadata = null, scene = null, ready = false, playing = null, stripKey = '', pathKey = '', searching = false, current = null, restored = false, ritual = null;
const selectedSites = () => state.selected.map(id => sites.find(s => s.id === id));
const primarySite = () => sites.find(s => s.id === state.primary);
const windowKey = () => [state.date.toISOString(), state.selected.join(','), state.heightM].join('|');
// The best window does not depend on the hour on screen, only on the sites compared and the observer height.
const bestKey = () => [state.selected.join(','), state.heightM].join('|');
function setBest(found) { state.best = { start: found.start.toISOString(), end: found.end.toISOString(), hours: found.hours, key: bestKey() }; }
function renderBest(busy = false) {
  const el = $('#bestDates'), best = state.best?.key === bestKey() ? state.best : null;
  el.hidden = !best && !busy; el.classList.toggle('busy', busy); el.title = t('best.title'); if (el.hidden) return;
  if (busy) { $('#bestHours').textContent = '…'; $('#bestWhat').textContent = t('best.searching'); $('#bestDatesRange').textContent = ''; el.classList.remove('inside'); return; }
  if (best.none) { $('#bestHours').textContent = '0 h'; $('#bestWhat').textContent = t('best.none'); $('#bestDatesRange').textContent = ''; el.classList.remove('inside'); return; }
  const start = new Date(best.start), end = new Date(best.end), inside = state.date >= start && state.date < end, short = d => utcDate(d).replace(' UTC', '');
  $('#bestHours').textContent = `${best.hours} h`;
  $('#bestWhat').textContent = t('best.what', { sites: selectedSites().map(s => SHORT[s.id]).join(' + ') });
  $('#bestDatesRange').textContent = `${short(start)} → ${short(end)} UTC · ${t(inside ? 'best.inside' : 'best.go')}`;
  el.classList.toggle('inside', inside);
}
let bestToken = 0, bestTimer = null;
function refreshBest(delay = 450) {
  clearTimeout(bestTimer); const token = ++bestToken;
  if (!ready || state.best?.key === bestKey()) { renderBest(); return; }
  renderBest(true);
  bestTimer = setTimeout(async () => {
    await ensureTerrains(state.selected);
    const found = await searchWindow(new Date(state.date), selectedSites(), state.heightM, state.panel).catch(() => null);
    if (token !== bestToken) return;
    state.best = found ? { start: found.start.toISOString(), end: found.end.toISOString(), hours: found.hours, key: bestKey() } : { none: true, key: bestKey() };
    renderBest(); save();
  }, delay);
}
function pulseBest() { const el = $('#bestDates'); el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse'); }

function chosenWindow() {
  if (state.window?.key === windowKey() && state.selected.includes(state.primary)) return { start: new Date(state.window.start), end: new Date(state.window.end), source: 'search' };
  return { start: new Date(state.date), end: new Date(+state.date + 24 * 36e5), source: 'manual' };
}
function validDate(date) { return Number.isFinite(date?.getTime()) && date >= new Date('2000-01-01T00:00Z') && date <= new Date('2050-12-31T23:59Z'); }
function save() { try { localStorage.setItem(STORE, JSON.stringify({ ...state, readingLight: undefined, psr: undefined })); } catch { /* storage optional */ } }
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE)); if (!s) return false;
    if (Array.isArray(s.selected) && s.selected.length >= 1 && s.selected.length <= 3 && new Set(s.selected).size === s.selected.length && s.selected.every(id => sites.some(site => site.id === id))) state.selected = s.selected;
    if (sites.some(site => site.id === s.primary)) state.primary = s.primary;
    if (!state.selected.includes(state.primary)) state.selected = [state.primary, ...state.selected].slice(0, 3);
    if (validDate(new Date(s.date))) state.date = new Date(s.date);
    if (Number.isInteger(s.heightM) && s.heightM >= 2 && s.heightM <= 20 && s.heightM % 2 === 0) state.heightM = s.heightM;
    if (['tracking', 'horizontal'].includes(s.panel)) state.panel = s.panel;
    if (['terrain', 'surface', 'globe'].includes(s.view)) state.view = s.view;
    if (s.best && validDate(new Date(s.best.start)) && validDate(new Date(s.best.end)) && Number.isFinite(s.best.hours) && typeof s.best.key === 'string') state.best = s.best;
    if (s.window?.key === windowKey() && validDate(new Date(s.window.start)) && validDate(new Date(s.window.end)) && new Date(s.window.end) > new Date(s.window.start)) state.window = s.window;
    return true;
  } catch { return false; }
}

let messageTimer = 0, messageKey = null;
// say(): a message from the dictionary, rewritten if the language changes while it shows.
function say(key, vars = {}, error = false, sticky = false) { message(t(key, vars), error, sticky); messageKey = { key, vars }; }
function message(text, error = false, sticky = false) {
  messageKey = null;
  $('#appMessageText').textContent = text;
  $('#appMessage').className = `message ${text ? 'visible' : ''} ${error ? 'error' : ''}`;
  clearTimeout(messageTimer);
  if (text && !error && !sticky) messageTimer = setTimeout(() => message(''), 9000);
}
$('#appMessageClose').addEventListener('click', () => message(''));

function setDate(date, keepMessage = false) {
  if (!validDate(date)) { say('msg.dateRange', {}, true); $('#dateTime').value = state.date.toISOString().slice(0, 16); return false; }
  state.date = new Date(date); if (!keepMessage) message(''); render(); return true;
}

function renderSites() {
  $('#siteList').innerHTML = sites.map((s, i) => {
    const compared = state.selected.includes(s.id), primary = state.primary === s.id;
    const toggle = primary ? '' : `<button type="button" class="site-compare" data-site-compare="${s.id}" aria-pressed="${compared}" aria-label="${t(compared ? 'sites.uncompare' : 'sites.compare', { name: siteName(s) })}" title="${t(compared ? 'sites.uncompare' : 'sites.compare', { name: siteName(s) })}"><svg aria-hidden="true"><use href="#i-${compared ? 'check' : 'plus'}"/></svg></button>`;
    return `<div class="site-chip ${compared ? 'compared' : ''} ${primary ? 'primary' : ''}"><button type="button" class="site-main" data-site-focus="${s.id}" data-tip-site="${s.id}" aria-pressed="${primary}" aria-label="${t('sites.explore', { name: siteName(s) })}"><span class="n"><span>${i + 1}</span></span>${SHORT[s.id]}</button>${toggle}</div>`;
  }).join('');
  $$('[data-site-focus]').forEach(el => el.addEventListener('click', () => exploreSite(el.dataset.siteFocus)));
  $$('[data-site-compare]').forEach(el => el.addEventListener('click', () => toggleCompare(el.dataset.siteCompare)));
  bindTips($('#siteList'));
}
// Exploring another site replaces the one explored before; comparing stays a separate, explicit choice.
async function exploreSite(id) {
  hideTip(); if (id === state.primary) return;
  const previous = state.primary; state.primary = id;
  state.selected = [id, ...state.selected.filter(s => s !== id && s !== previous)];
  renderSites(); await ensureTerrains(state.selected); render(); refreshBest();
}
async function toggleCompare(id) {
  if (state.selected.includes(id)) state.selected = state.selected.filter(s => s !== id);
  else { if (state.selected.length >= 3) { say('sites.max'); return; } state.selected = [...state.selected, id]; }
  message(''); renderSites(); await ensureTerrains(state.selected); render(); refreshBest();
}
// Tracks and scene pins switch the explored site among those already compared, keeping the comparison.
async function focusSite(id) { hideTip(); state.primary = id; if (!state.selected.includes(id)) state.selected = [id, ...state.selected].slice(0, 3); renderSites(); await ensureTerrains(state.selected); render(); }

// What each numbered site is and where it lies: a small south-polar map, distance from the explored site, state now.
function polarMap(id) {
  const c = 48, k = 8.6, at = s => { const r = (90 + s.lat) * k, a = s.lon * RAD; return [c + r * Math.sin(a), c - r * Math.cos(a)]; };
  let out = `<svg viewBox="0 0 96 96" aria-hidden="true"><circle class="tip-ring" cx="${c}" cy="${c}" r="${2 * k}"/><circle class="tip-ring" cx="${c}" cy="${c}" r="${4 * k}"/><line class="tip-axis" x1="${c}" y1="4" x2="${c}" y2="92"/><line class="tip-axis" x1="4" y1="${c}" x2="92" y2="${c}"/><path class="tip-pole" d="M${c - 3} ${c}h6M${c} ${c - 3}v6"/><text class="tip-text" x="${c + 2}" y="10">0°</text><text class="tip-text" x="${c + 2 * k + 1}" y="${c + 9}">88°</text><text class="tip-text" x="${c + 4 * k + 1}" y="${c + 9}">86°</text>`;
  sites.forEach((s, i) => { const [x, y] = at(s), on = s.id === id; out += `<circle class="tip-site${on ? ' on' : ''}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${on ? 7 : 5.5}"/><text class="tip-num" x="${x.toFixed(1)}" y="${(y + 2.8).toFixed(1)}" text-anchor="middle">${i + 1}</text>`; });
  return out + '</svg>';
}
function showTip(el) {
  const s = sites.find(x => x.id === el.dataset.tipSite); if (!s) return;
  const tip = $('#siteTip'), primary = primarySite(), lines = [];
  lines.push(`<h3>${sites.indexOf(s) + 1} · ${siteName(s)}</h3>`, `<p>${t(`about.${s.id}`)}</p>`);
  lines.push(`<p class="num">${coords(s)}${s.id === primary.id ? '' : ` · ${t('tip.from', { km: `${number(Math.round(surfaceKm(s, primary)))} km`, site: SHORT[primary.id] })}`}</p>`);
  if (s.id === primary.id) lines.push(`<p class="tip-now">${t('tip.here')}</p>`);
  if (ready && terrains.has(s.id)) { const m = evaluate(s, state.date, terrains.get(s.id), astronomy, state.heightM, state.panel); lines.push(`<p class="tip-now">${t('tip.now', { sun: t(m.sun.available ? 'sun.visible' : 'sun.blocked'), earth: t(m.earth.available ? 'earth.visible' : 'earth.blocked') })}</p>`); }
  lines.push(`<small>${t('tip.limit')}</small>`);
  tip.innerHTML = polarMap(s.id) + lines.join(''); tip.hidden = false;
  const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
  const left = clamp(r.left + r.width / 2 - w / 2, 12, innerWidth - w - 12), top = r.top - h - 12 >= 12 ? r.top - h - 12 : Math.min(innerHeight - h - 12, r.bottom + 12);
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  el.setAttribute('aria-describedby', 'siteTip');
}
function hideTip() { const tip = $('#siteTip'); if (tip) tip.hidden = true; }
function bindTips(root) {
  root.querySelectorAll('[data-tip-site]').forEach(el => {
    el.addEventListener('mouseenter', () => showTip(el)); el.addEventListener('focus', () => showTip(el));
    el.addEventListener('mouseleave', hideTip); el.addEventListener('blur', hideTip);
  });
}
addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
addEventListener('scroll', hideTip, { passive: true });
function setView(view) {
  state.view = view; $('#sceneBox').dataset.view = view;
  $$('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  scene?.setView(view); render();
}

// 24 hours of Sun and Earth directions for the primary site, every 30 minutes.
function computePaths(site, terrain, date) {
  const key = [site.id, state.heightM, Math.floor(+date / 6e5)].join('|');
  if (key === pathKey && computePaths.last) return computePaths.last;
  const out = { sun: [], earth: [] };
  for (let i = 0; i <= 48; i++) {
    const m = evaluate(site, new Date(+date + i * 18e5), terrain, astronomy, state.heightM, state.panel);
    for (const body of ['sun', 'earth']) out[body].push({ direction: m[body].direction, visible: m[body].available, azimuth: m[body].azimuth, elevation: m[body].elevation });
  }
  pathKey = key; computePaths.last = out; return out;
}

// One plain sentence per body: what the numbers mean for someone standing there.
function verdict(body, m, edge) {
  if (body === 'sun') {
    // The Earth in front of the Sun (a lunar eclipse seen from the Earth), when the relief leaves the Sun in view.
    if (m.eclipse > 0 && m.terrainFraction > 0) return m.eclipse >= 1 ? t('verdict.sun.eclipseTotal') : t('verdict.sun.eclipse', { p: Math.round(m.eclipse * 100), v: Math.round(m.diskFraction * 100) });
    if (m.diskFraction >= 1) return t(m.elevation < 0 ? 'verdict.sun.high' : 'verdict.sun.full');
    if (m.diskFraction > 0) return t('verdict.sun.partial', { p: Math.round(m.diskFraction * 100) });
    return t(m.elevation > 0 ? 'verdict.sun.hidden' : 'verdict.sun.down');
  }
  if (m.available) return t(m.elevation < 0 ? 'verdict.earth.high' : edge ? 'verdict.earth.edge' : 'verdict.earth.visible');
  return t(m.elevation > 0 ? 'verdict.earth.hidden' : 'verdict.earth.down');
}

function render() {
  const d = state.date, site = primarySite();
  if (state.window?.key !== windowKey()) state.window = null;
  renderBest();
  save();
  $('#dateTime').value = d.toISOString().slice(0, 16);
  $('#hourOutput').textContent = d.toISOString().slice(11, 16) + ' UTC';
  $('#hourSlider').value = d.getUTCHours() * 60 + d.getUTCMinutes();
  $('#heightOutput').textContent = state.heightM + ' m';
  $('#primarySiteName').textContent = siteName(site);
  $('#sceneCoordinates').textContent = coords(site);
  $('#cameraHint').textContent = t(state.view === 'surface' ? 'hint.surface' : state.view === 'globe' ? 'hint.globe' : 'hint.terrain');
  $('#scaleLabel').textContent = scene?.telephoto && state.view === 'surface' ? t('scale.tele') : t(state.view === 'surface' ? 'scale.surface' : state.view === 'globe' ? 'scale.globe' : 'scale.terrain', { h: state.heightM });
  const terrain = terrains.get(state.primary);
  if (!ready || !terrain) return;
  current = evaluate(site, d, terrain, astronomy, state.heightM, state.panel);
  for (const body of ['sun', 'earth']) {
    const m = current[body], row = $(`#${body}Row`);
    // Visible or not is the model's answer (margin > 0, as the window search uses); "grazing" only qualifies it:
    // part of the Sun's disc is hidden, or the relief cuts the Earth's disc (radius ~0.95°).
    const edge = body === 'sun' ? m.terrainFraction > 0 && m.terrainFraction < 1 : Math.abs(m.margin) < Math.asin(6378.137 / m.distanceKm) / RAD;
    const eclipse = body === 'sun' && m.terrainFraction > 0 ? m.eclipse : 0;
    row.dataset.state = m.available ? 'visible' : 'blocked'; row.dataset.edge = String(edge);
    $(`#${body}Status`).textContent = eclipse >= 1 ? t('state.eclipse') : t(`state.${m.available ? 'visible' : 'blocked'}`) + (edge ? t('state.grazing') : '') + (eclipse > 0 ? t('state.partialEclipse') : '');
    // Shown parts are rounded first, so the subtraction on screen adds up.
    const sky = Math.round(m.elevation * 100) / 100, relief = Math.round(m.horizon * 100) / 100, margin = sky - relief;
    $(`#${body}MarginText`).textContent = t(margin >= 0 ? 'answer.above' : 'answer.below', { v: `${number(Math.abs(margin), 2)}°` });
    $(`#${body}Verdict`).textContent = verdict(body, m, edge);
    const plain = v => `${v < 0 ? '−' : ''}${number(Math.abs(v), 2)}°`;
    $(`#${body}Elevation`).textContent = plain(sky);
    $(`#${body}HorizonLabel`).textContent = t('answer.horizonAt', { az: `${number(Math.round(m.azimuth))}° ${compass(m.azimuth)}` });
    $(`#${body}Horizon`).textContent = relief < 0 ? `(${plain(relief)})` : plain(relief);
    $(`#${body}MarginValue`).textContent = plain(margin);
    $(`#${body}Label b`).textContent = state.view === 'surface' ? t('label.sky', { v: signedDegrees(sky) }) : t(margin >= 0 ? 'answer.above' : 'answer.below', { v: `${number(Math.abs(margin), 2)}°` });
  }
  $('#earthNote').textContent = t('answer.earthNote', { km: `${number(Math.round(current.earth.distanceKm))} km` });
  // Light on a panel against what the full Sun would give at this distance.
  const fullSun = 1361 / (current.sun.distanceKm / AU_KM) ** 2, share = clamp(current.irradiance / fullSun, 0, 1);
  $('#irradiance').textContent = `${Math.round(current.irradiance)} W/m²`;
  $('#irradianceNote').textContent = current.sun.diskFraction === 0 ? t('irr.none') : [t('answer.fullSun', { p: Math.round(share * 100) }), state.panel === 'horizontal' ? t('irr.flat', { el: signedDegrees(current.sun.elevation) }) : ''].join(' ').trim();
  $('#solarMeter').style.transform = `scaleX(${share})`;
  // What raising the eye changes, against the 2 m default.
  if (state.heightM > 2) { const low = evaluate(site, d, terrain, astronomy, 2, state.panel); $('#heightEffect').textContent = t('height.effect', { h: state.heightM, a: signedDegrees(low.sun.horizon), b: signedDegrees(current.sun.horizon) }); }
  else $('#heightEffect').textContent = '';
  $('#cameraHint').hidden = state.heightM > 2;
  const light = state.readingLight ? 'reading' : current.sun.eclipse > 0 && current.sun.terrainFraction > 0 ? (current.sun.eclipse >= 1 ? 'eclipse' : 'partial') : current.sun.diskFraction === 0 ? 'dark' : current.sun.diskFraction < 1 ? 'partial' : 'real';
  $('#lightingBadge').textContent = t(`light.${light}`, { p: Math.round(current.sun.diskFraction * 100) }) + (state.psr ? ` · ${t('psr.legend')}` : '');
  $('.stage-meta').dataset.light = light;
  const paths = computePaths(site, terrain, d);
  if (scene) { scene.update(current, d, state.heightM, state.selected); scene.setTerrain(terrain); scene.setPaths(paths); }
  renderHorizon(terrain, current, paths); renderTracks();
}

function renderHorizon(terrain, result, paths) {
  // Small chart next to the Sun/Earth answer, so it can be followed while time runs.
  const horizon = terrain.horizon(state.heightM), W = 300, H = 120, L = 30, T = 15, B = 16, R = 4;
  const els = [...horizon, result.sun.elevation, result.earth.elevation];
  const lower = Math.min(-4, Math.floor(Math.min(...els) / 2) * 2), upper = Math.max(8, Math.ceil(Math.max(...els) / 2) * 2);
  const x = az => L + az / 360 * (W - L - R), y = el => T + (upper - el) / (upper - lower) * (H - T - B);
  let out = `<title id="horizonTitle">${t('horizon.title')}</title><desc id="horizonDesc">${t('horizon.desc')} ${t('horizon.axis')}. ${t('horizon.note')}</desc>`;
  out += `<text x="${L}" y="9" class="hz-caption">${t('horizon.sky')} · ${t('horizon.seenFrom', { h: state.heightM })}</text>`;
  for (const el of [lower, upper]) out += `<line x1="${L}" x2="${W - R}" y1="${y(el)}" y2="${y(el)}" class="hz-grid"/>`;
  for (const el of [lower, 0, upper]) out += `<text x="${L - 5}" y="${y(el) + 3.5}" text-anchor="end" class="hz-text">${number(el)}°</text>`;
  t('horizon.cardinal').split(',').forEach((c, i) => { out += `<text x="${x(i * 90)}" y="${H - 4}" text-anchor="${i === 0 ? 'start' : 'middle'}" class="hz-text">${c}</text>`; });
  out += `<text x="${W - R}" y="${H - 4}" text-anchor="end" class="hz-text">${t('horizon.cardinal').split(',')[0]}</text>`;
  const relief = Array.from(horizon, (h, i) => `${i ? 'L' : 'M'}${x(i / 2).toFixed(1)},${y(h).toFixed(1)}`).join(' ');
  out += `<path d="${relief} L${x(360)},${y(lower)} L${x(0)},${y(lower)} Z" class="hz-relief"/>`;
  // The flat horizon goes over the relief, so it reads as a reference line, labelled at its end.
  out += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="hz-zero"/><text x="${W - R - 2}" y="${y(0) - 4}" text-anchor="end" class="hz-text">${t('horizon.flat')}</text>`;
  const marks = ['sun', 'earth'].map(body => { const m = result[body]; return { body, m, px: x(m.azimuth), py: y(m.elevation), ry: y(m.horizon) }; });
  for (const k of marks) out += `<line x1="${k.px.toFixed(1)}" x2="${k.px.toFixed(1)}" y1="${k.ry.toFixed(1)}" y2="${k.py.toFixed(1)}" class="hz-margin-${k.body}"/>`;
  for (const k of marks) out += `<circle cx="${k.px.toFixed(1)}" cy="${k.py.toFixed(1)}" r="5" class="hz-now-${k.body}"><title>${t(k.body)} · ${signedDegrees(k.m.elevation)} · ${degrees(k.m.azimuth)}</title></circle>`;
  // Labels beside the dots, nudged apart when the Sun and the Earth are close on the chart.
  const [a, b] = marks; let dy = 0; if (Math.abs(a.px - b.px) < 64 && Math.abs(a.py - b.py) < 14) dy = a.py <= b.py ? 7 : -7;
  for (const [k, shift] of [[a, -dy], [b, dy]]) { const right = k.px < W - 70; out += `<text x="${(k.px + (right ? 9 : -9)).toFixed(1)}" y="${(k.py + 4 + shift).toFixed(1)}" text-anchor="${right ? 'start' : 'end'}" class="hz-label">${t(k.body)}</text>`; }
  $('#horizonChart').innerHTML = out;
}

// One track per compared site under the time scrubber, for the UTC day of the chosen date:
// Sun on top, Earth below, hatched when behind the relief. On the right, the longest stretch with both.
function renderTracks() {
  const base = new Date(state.date); base.setUTCHours(0, 0, 0, 0);
  const shown = sites.filter(s => s.id === state.primary || state.selected.includes(s.id));
  if (!shown.every(s => terrains.has(s.id))) return;
  const key = [shown.map(s => s.id).join(','), state.primary, base.toISOString(), state.heightM, state.panel, getLang()].join('|');
  if (key === stripKey) return; stripKey = key;
  const vectors = Array.from({ length: 24 }, (_, h) => ephemeris(new Date(+base + h * 36e5), astronomy));
  const rows = shown.map(s => {
    const both = [];
    const cells = vectors.map((eph, h) => {
      const m = evaluate(s, new Date(+base + h * 36e5), terrains.get(s.id), astronomy, state.heightM, state.panel, eph);
      both.push(m.sun.available && m.earth.available);
      return `<i class="${m.sun.available ? 's1' : 's0'} ${m.earth.available ? 'e1' : 'e0'}"></i>`;
    }).join('');
    return { s, cells, best: longestRun(both).length, primary: s.id === state.primary };
  });
  $('#dayStrip').innerHTML = rows.map(r => `<div class="day-row${r.primary ? ' primary' : ''}">${r.cells}</div>`).join('');
  $('#trackSites').innerHTML = rows.map(r => `<button type="button" data-track-site="${r.s.id}" data-tip-site="${r.s.id}" class="${r.primary ? 'primary' : ''}" aria-pressed="${r.primary}" aria-label="${t('sites.explore', { name: siteName(r.s) })}">${sites.indexOf(r.s) + 1}</button>`).join('');
  $('#trackBest').innerHTML = rows.map(r => `<span class="${r.primary ? 'primary' : ''}" title="${t('strip.bestTitle', { site: siteName(r.s), h: r.best })}">${r.best} h</span>`).join('');
  $('.scrub-grid').style.setProperty('--rows', rows.length);
  $$('[data-track-site]').forEach(el => el.addEventListener('click', () => focusSite(el.dataset.trackSite)));
  bindTips($('#trackSites'));
}

function stopPlayback() {
  if (playing) clearInterval(playing); playing = null;
  const b = $('#playButton'); b.setAttribute('aria-pressed', 'false'); b.dataset.i18nAttr = 'aria-label:time.play'; b.setAttribute('aria-label', t('time.play'));
}

// Longest continuous Sun + Earth interval for the selection in the next 30 days.
async function searchWindow(from, selection, heightM, panel) {
  const hours = [];
  for (let h = 0; h < 720; h++) {
    const date = new Date(+from + h * 36e5); if (!validDate(date)) break;
    const eph = ephemeris(date, astronomy);
    hours.push(selection.every(s => { const m = evaluate(s, date, terrains.get(s.id), astronomy, heightM, panel, eph); return m.sun.available && m.earth.available; }));
    if (h % 48 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  const best = longestRun(hours);
  if (!best.length) return null;
  const start = new Date(+from + best.start * 36e5);
  return { start, end: new Date(+start + best.length * 36e5), hours: best.length };
}
async function findBestWindow() {
  if (searching || !ready) return; stopPlayback(); searching = true;
  const button = $('#bestWindow'); button.disabled = true; button.textContent = t('action.searching');
  const snapshot = { date: new Date(state.date), sites: selectedSites(), heightM: state.heightM, panel: state.panel };
  try {
    await ensureTerrains(state.selected);
    const found = await searchWindow(snapshot.date, snapshot.sites, snapshot.heightM, snapshot.panel);
    if (!found) { say('msg.noWindow'); return; }
    if (+state.date !== +snapshot.date || state.heightM !== snapshot.heightM || state.selected.join(',') !== snapshot.sites.map(s => s.id).join(',')) { say('msg.changed'); return; }
    setBest(found); setDate(found.start, true); state.window = { start: found.start.toISOString(), end: found.end.toISOString(), key: windowKey() }; render();
    // The result lands in the window card, not in a toast over the sky.
    pulseBest(); button.textContent = t('action.found', { h: found.hours }); setTimeout(() => { if (!searching) button.textContent = t('action.best'); }, 2500);
  } finally { searching = false; button.disabled = false; if (button.textContent === t('action.searching')) button.textContent = t('action.best'); }
}

// First visit: the room goes dark, the stars come up and time runs until the Sun clears the rim.
async function openingRitual() {
  const found = await searchWindow(new Date(), selectedSites(), state.heightM, state.panel).catch(() => null);
  if (!found) { render(); return; }
  const end = found.start, start = new Date(+end - 6 * 36e5);
  state.date = new Date(end); render(); scene?.resetCamera();
  setBest(found);
  const finish = () => { ritual = null; state.date = new Date(end); state.window = { start: end.toISOString(), end: found.end.toISOString(), key: windowKey() }; render(); pulseBest(); };
  if (reducedMotion || !scene) { finish(); return; }
  const duration = 4200, t0 = performance.now();
  ritual = { cancel: false };
  const step = now => {
    if (!ritual || ritual.cancel) return;
    const k = Math.min(1, (now - t0) / duration), e = 1 - Math.pow(1 - k, 3);
    state.date = new Date(+start + (end - start) * e); render();
    if (k < 1) requestAnimationFrame(step); else finish();
  };
  requestAnimationFrame(step);
}
const cancelRitual = () => { if (ritual) ritual.cancel = true; ritual = null; };

async function loadTerrain(site) {
  if (terrains.has(site.id)) return terrains.get(site.id);
  const response = await fetch(data(`./data/${site.id}.bin`));
  if (!response.ok) throw new Error(t('error.data', { name: siteName(site) }));
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== metadata.tileSize ** 2 * 4) throw new Error(t('error.data', { name: siteName(site) }));
  let wide = null;
  if (metadata.wide) {
    const w = await fetch(data(`./data/${site.id}-wide.bin`)).then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
    if (w && w.byteLength === metadata.wide.tileSize ** 2 * 4) wide = new Float32Array(w);
  }
  let inner = null, psr = null;
  if (metadata.inner) {
    const b = await fetch(data(`./data/${site.id}-inner.bin`)).then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
    if (b && b.byteLength === metadata.inner.tileSize ** 2 * 4) inner = new Float32Array(b);
  }
  if (metadata.psr) {
    const b = await fetch(data(`./data/${site.id}-psr.bin`)).then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
    if (b && b.byteLength === metadata.psr.tileSize ** 2) psr = new Uint8Array(b);
  }
  const terrain = new Terrain(site, new Float32Array(buffer), metadata, wide, inner, psr);
  terrains.set(site.id, terrain); return terrain;
}
const ensureTerrains = ids => Promise.all(ids.map(id => loadTerrain(sites.find(s => s.id === id))));

// Controls
$('#dateTime').addEventListener('change', () => { cancelRitual(); stopPlayback(); setDate(new Date($('#dateTime').value + 'Z')); });
$('#nowButton').addEventListener('click', () => { cancelRitual(); stopPlayback(); setDate(new Date()); });
$$('[data-shift]').forEach(b => b.addEventListener('click', () => { cancelRitual(); stopPlayback(); setDate(new Date(+state.date + Number(b.dataset.shift) * 36e5)); }));
$('#bestWindow').addEventListener('click', () => { cancelRitual(); findBestWindow(); });
$('#bestDates').addEventListener('click', () => {
  if (!state.best) return; cancelRitual(); stopPlayback(); const start = new Date(state.best.start);
  if (setDate(start)) { state.window = { start: state.best.start, end: state.best.end, key: windowKey() }; render(); }
});
$('#height').addEventListener('input', () => { state.heightM = Number($('#height').value); render(); refreshBest(700); if (state.view === 'surface') scene?.resetCamera(); });
// Every box over the scene folds away with its chevron; the choice is remembered.
function setFold(name, open) {
  const button = $(`[data-fold="${name}"]`); if (!button) return; const body = $(`#${button.getAttribute('aria-controls')}`);
  body.hidden = !open; button.setAttribute('aria-expanded', String(open));
  const label = t(open ? 'fold.hide' : 'fold.show', { name: name === 'chart' ? t('fold.chart') : name === 'console' ? t('fold.console') : t(name) }); button.setAttribute('aria-label', label); button.title = label;
}
let folds = {}; try { folds = JSON.parse(localStorage.getItem(FOLDS)) || {}; } catch { /* storage optional */ }
// On a short desktop window the console starts with its date and site row folded (until the visitor chooses).
const shortScreen = matchMedia('(min-width: 1181px) and (max-height: 860px)').matches;
$$('[data-fold]').forEach(b => { const name = b.dataset.fold; setFold(name, name in folds ? folds[name] !== false : !(name === 'console' && shortScreen)); b.addEventListener('click', () => { const open = b.getAttribute('aria-expanded') !== 'true'; setFold(b.dataset.fold, open); folds[b.dataset.fold] = open; try { localStorage.setItem(FOLDS, JSON.stringify(folds)); } catch { /* storage optional */ } }); });
$$('[name=panel]').forEach(el => el.addEventListener('change', () => { state.panel = el.value; render(); }));
$$('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
$('#hourSlider').addEventListener('input', () => { cancelRitual(); stopPlayback(); const date = new Date(state.date); date.setUTCHours(0, Number($('#hourSlider').value), 0, 0); setDate(date); });
$('#playButton').addEventListener('click', () => {
  cancelRitual();
  if (playing) { stopPlayback(); return; } if (!ready) return;
  const b = $('#playButton'); b.setAttribute('aria-pressed', 'true'); b.dataset.i18nAttr = 'aria-label:time.pause'; b.setAttribute('aria-label', t('time.pause'));
  playing = setInterval(() => { if (document.hidden) return; if (!setDate(new Date(+state.date + 10 * 60e3))) stopPlayback(); }, 200);
});
// Sun and Earth buttons look through a lens from the observer's eye: the Earth fills the view with its real phase.
const lookAt = body => { if (state.view !== 'surface') setView('surface'); scene?.focus(body); render(); };
$('#focusSun').addEventListener('click', () => lookAt('sun'));
$('#focusEarth').addEventListener('click', () => lookAt('earth'));
$('#psrLayer').addEventListener('click', () => {
  state.psr = !state.psr; $('#psrLayer').setAttribute('aria-pressed', String(state.psr));
  scene?.setPsr(state.psr); render();
});
$('#resetCamera').addEventListener('click', () => { scene?.resetCamera(); render(); });
$('#readingLight').addEventListener('click', () => {
  state.readingLight = !state.readingLight; $('#readingLight').setAttribute('aria-pressed', String(state.readingLight));
  scene?.setReadingLight(state.readingLight); render();
});
$('#fullscreenButton').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('#sceneViewport').requestFullscreen(); } catch { say('msg.fullscreen'); } });
const about = $('#aboutDialog');
for (const id of ['#helpButton', '#footerMethod']) $(id).addEventListener('click', () => about.showModal());
$('.dialog-close').addEventListener('click', () => about.close());
about.addEventListener('click', e => { if (e.target === about) { const r = about.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) about.close(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) scene?.invalidate(); });
window.addEventListener('pagehide', () => { stopPlayback(); scene?.dispose(); });

const mission = new MissionUI(astronomy, () => { if (scene) { scene.suspended = false; scene.invalidate(); } });
$('#missionButton').addEventListener('click', async () => {
  if (!ready) return; cancelRitual(); stopPlayback();
  const site = primarySite(), terrain = await loadTerrain(site);
  let win = chosenWindow();
  // If the chosen hour leaves the destination without Sun and Earth, land at the next window that has
  // both, as the Apollo planners chose a low, rising Sun for each landing site.
  const now = evaluate(site, state.date, terrain, astronomy, state.heightM, state.panel);
  if (win.source === 'manual' && !(now.sun.available && now.earth.available)) {
    const button = $('#missionButton'); button.disabled = true; button.textContent = t('action.searching');
    try { const found = await searchWindow(new Date(state.date), [site], state.heightM, state.panel); if (found) win = { start: found.start, end: found.end, source: 'search' }; }
    finally { button.disabled = false; button.textContent = t('action.mission'); }
  }
  if (scene) scene.suspended = true;
  mission.open({ site, terrain, window: win, heightM: state.heightM, panel: state.panel });
});

bindLanguageSwitch();
// The scene tools sit right above the console, whatever its height.
const consoleBox = $('.console');
new ResizeObserver(() => $('#sceneViewport').style.setProperty('--console-h', `${consoleBox.offsetHeight}px`)).observe(consoleBox);
onLangChange(() => { document.title = t('meta.appTitle'); if (messageKey) $('#appMessageText').textContent = t(messageKey.key, messageKey.vars); stripKey = ''; $$('[data-fold]').forEach(b => setFold(b.dataset.fold, b.getAttribute('aria-expanded') === 'true')); renderSites(); render(); mission.refreshLanguage(); if (!searching) $('#bestWindow').textContent = t('action.best'); });
document.title = t('meta.appTitle');

// WebMCP tools for agents in the browser.
function readVisibility() {
  return { utcDate: state.date.toISOString(), primarySite: state.primary, camera: state.view, heightM: state.heightM, panel: state.panel, window: chosenWindow(),
    sites: selectedSites().filter(s => terrains.has(s.id)).map(s => { const m = evaluate(s, state.date, terrains.get(s.id), astronomy, state.heightM, state.panel); return { id: s.id, name: siteName(s), sunElevation: m.sun.elevation, sunAzimuth: m.sun.azimuth, sunMargin: m.sun.margin, earthElevation: m.earth.elevation, earthMargin: m.earth.margin, irradianceWm2: m.irradiance }; }) };
}
function registerWebMCP() {
  const ctx = document.modelContext; if (!ctx?.registerTool) return;
  const lifecycle = new AbortController(); window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  const register = tool => { try { Promise.resolve(ctx.registerTool(tool, { signal: lifecycle.signal })).catch(e => console.warn('WebMCP registration:', e)); } catch (e) { console.warn('WebMCP registration:', e); } };
  register({ name: 'configure_lunar_comparison', title: 'Configure lunar comparison', description: 'Selects one to three sites, the UTC date and optionally the camera and observer height.', inputSchema: { type: 'object', properties: { siteIds: { type: 'array', items: { type: 'string', enum: sites.map(s => s.id) }, minItems: 1, maxItems: 3, uniqueItems: true }, utcDate: { type: 'string', description: 'ISO 8601 with an explicit offset' }, camera: { type: 'string', enum: ['terrain', 'surface', 'globe'] }, heightM: { type: 'integer', minimum: 2, maximum: 20, multipleOf: 2 } }, required: ['siteIds', 'utcDate'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, async execute(input) {
    if (!input || Object.keys(input).some(k => !['siteIds', 'utcDate', 'camera', 'heightM'].includes(k))) throw new Error('Unknown parameters.');
    if (!Array.isArray(input.siteIds) || input.siteIds.length < 1 || input.siteIds.length > 3 || new Set(input.siteIds).size !== input.siteIds.length || input.siteIds.some(id => !sites.find(s => s.id === id))) throw new Error('Select one to three distinct, valid sites.');
    const d = new Date(input.utcDate); if (typeof input.utcDate !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(input.utcDate) || !validDate(d)) throw new Error('Invalid UTC date or outside 2000–2050.');
    if (input.camera && !['terrain', 'surface', 'globe'].includes(input.camera)) throw new Error('Invalid camera.');
    if (input.heightM !== undefined && (!Number.isInteger(input.heightM) || input.heightM < 2 || input.heightM > 20 || input.heightM % 2)) throw new Error('Height must be even, from 2 to 20 m.');
    cancelRitual(); stopPlayback(); message(''); state.selected = [...input.siteIds]; state.primary = state.selected[0]; state.date = d;
    if (input.heightM !== undefined) { state.heightM = input.heightM; $('#height').value = state.heightM; }
    await ensureTerrains(state.selected); renderSites(); setView(input.camera || state.view); await new Promise(requestAnimationFrame); return readVisibility();
  } });
  register({ name: 'read_lunar_visibility', title: 'Read lunar visibility', description: 'Reads elevations, margins over the LOLA horizon and irradiance at the selected sites.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: false }, execute: readVisibility });
}

// The first-visit guide: nine stops on the real controls. A folded box opens for its step (not saved).
const hoverTips = matchMedia('(hover: hover)').matches;
const guide = createGuide({
  t, onLangChange, button: $('#guideButton'),
  canStart: () => ready && !ritual && !document.querySelector('dialog[open]'),
  steps: [
    { id: 'sites', targets: () => [$('.console-sites')], title: 'guide.sites.t', body: () => (hoverTips ? 'guide.sites.d' : 'guide.sites.touch'), prepare: () => setFold('console', true) },
    { id: 'time', targets: () => [$('.scrub')], title: 'guide.time.t', body: 'guide.time.d' },
    { id: 'play', targets: () => [$('#playButton')], title: 'guide.play.t', body: 'guide.play.d' },
    { id: 'views', targets: () => [$('.view-tabs'), $('.stage-controls')], title: 'guide.views.t', body: 'guide.views.d' },
    { id: 'answer', targets: () => [$('#sunRow'), $('#earthRow')], title: 'guide.answer.t', body: 'guide.answer.d', prepare: () => { setFold('sun', true); setFold('earth', true); } },
    { id: 'chart', targets: () => [$('#chartRow')], title: 'guide.chart.t', body: 'guide.chart.d', prepare: () => setFold('chart', true) },
    { id: 'best', targets: () => [$('#bestWindow'), $('#bestDates')], title: 'guide.best.t', body: 'guide.best.d' },
    { id: 'mission', targets: () => [$('#missionButton')], title: 'guide.mission.t', body: 'guide.mission.d' },
    { id: 'again', targets: () => [$('#guideButton')], title: 'guide.again.t', body: 'guide.again.d' },
  ],
});

restored = restore();
$('#height').value = state.heightM; $(`[name=panel][value=${state.panel}]`).checked = true;
renderSites(); $('#sceneBox').dataset.view = state.view; $$('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));

async function init() {
  try {
    if (!astronomy) throw new Error(t('error.ephemeris'));
    const response = await fetch(data('./data/metadata.json')); if (!response.ok) throw new Error(t('error.data', { name: 'LOLA' }));
    metadata = await response.json();
    await ensureTerrains([...new Set([state.primary, ...state.selected])]);
    ready = true; $('#missionButton').disabled = false;
    try { scene = new LunarScene($('#sceneCanvas'), $('#sceneBox'), sites, text => message(text, true), { t, onSite: id => focusSite(id) }); }
    catch (error) { say('msg.webgl', {}, true); $('#sceneLoading').innerHTML = `<b>${t('loading.webglTitle')}</b><span>${t('loading.webglSub')}</span>`; console.warn(error); }
    scene?.setView(state.view);
    if (restored) { render(); refreshBest(0); } else await openingRitual();
    if (scene) { $('#sceneLoading').classList.add('hidden'); requestAnimationFrame(() => $('#sceneViewport').classList.add('ready')); }
    registerWebMCP();
    guide.maybeStart();
    ensureTerrains(sites.map(s => s.id)).catch(() => { /* other sites load on demand */ });
  } catch (error) {
    message(error.message, true); $('#sceneLoading').innerHTML = `<b>${t('loading.failTitle')}</b><span>${t('loading.failSub')}</span>`; console.error(error);
  }
}
init();
