import { evaluate } from './model.js';
import { HOUR, PHASES, ANIMATION_SECONDS, APOLLO, buildMission, sampleMission } from './mission-model.js';
import { MissionScene } from './mission-scene.js';
import { loadNasaModels } from './nasa-models.js';
import { t, number, utcDate } from './i18n.js';

const $ = s => document.querySelector(s);
const AT_MOON = new Set(['descent', 'surface', 'ascent']);
const coords = site => `${number(Math.abs(site.lat), 2)}° ${t('dir.S')} · ${number(Math.abs(site.lon), 2)}° ${site.lon < 0 ? t('dir.W') : t('dir.E')}`;

export class MissionUI {
  constructor(astronomy, onClose) {
    this.astronomy = astronomy; this.onClose = onClose; this.dialog = $('#missionDialog'); this.progress = 0; this.playing = false;
    $('#closeMission').addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => { this.stop(); cancelAnimationFrame(this.frame); this.pending?.dispose(); this.pending = null; this.scene?.dispose(); this.scene = null; onClose(); });
    $('#missionForm').addEventListener('submit', e => { e.preventDefault(); this.apply(); });
    $('#missionWindowHours').addEventListener('input', () => { if (!$('#missionWindowHours').disabled) $('#missionStay').max = Number($('#missionWindowHours').value); });
    $('#missionPlay').addEventListener('click', () => { if (!this.plan) return; if (this.playing) this.stop(); else { if (this.progress >= 1) this.progress = 0; this.playing = true; this.last = performance.now(); this.playButton(); } });
    $('#missionReplay').addEventListener('click', () => { this.stop(); this.progress = 0; this.draw(true); });
    $('#missionProgress').addEventListener('input', () => { this.stop(); this.progress = Number($('#missionProgress').value) / 1000; this.draw(true); });
    $('#missionCamera').addEventListener('change', () => this.scene?.setMode($('#missionCamera').value));
    $('#missionResetCamera').addEventListener('click', () => this.draw(true));
    $('#missionFullscreen').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('#missionViewport').requestFullscreen(); } catch { $('#missionSceneMessage').textContent = t('mission.fullscreen'); } });
    document.addEventListener('visibilitychange', () => { this.last = performance.now(); });
    window.addEventListener('pagehide', () => { this.stop(); cancelAnimationFrame(this.frame); this.pending?.dispose(); this.scene?.dispose(); });
    $('#missionPhases').innerHTML = PHASES.map(p => `<button type="button" data-mission-phase="${p.id}" class="${AT_MOON.has(p.id) ? 'at-moon' : ''}" style="--w:${p.seconds}"></button>`).join('');
    document.querySelectorAll('[data-mission-phase]').forEach(button => button.addEventListener('click', () => { this.stop(); this.progress = PHASES.find(p => p.id === button.dataset.missionPhase).start; this.draw(true); }));
    this.labelPhases();
    // Speed labels from the real length of the playback.
    document.querySelectorAll('#missionSpeed option').forEach(o => { o.textContent = `${o.value}× · ${Math.round(ANIMATION_SECONDS / Number(o.value))} s`; });
  }
  labelPhases() {
    document.querySelectorAll('[data-mission-phase]').forEach(b => { const label = t(`phase.${b.dataset.missionPhase}`); b.setAttribute('aria-label', label); b.title = label; });
  }
  refreshLanguage() {
    this.labelPhases(); this.playButton();
    const msg = $('#missionSceneMessage'); if (this.preparing && msg.textContent.startsWith(this.preparing)) msg.textContent = msg.textContent.replace(this.preparing, this.preparing = t('mission.preparing'));
    if (this.dialog.open && this.context) { $('#missionCoordinates').textContent = coords(this.context.site); $('#missionSite').textContent = t(`site.${this.context.site.id}`); this.apply(true); }
  }
  async open(context) {
    this.context = context; this.progress = 0; this.stop(); this.plan = null; this.last = performance.now(); this.lastDraw = 0; this.conditionKey = '';
    $('#missionSite').textContent = t(`site.${context.site.id}`); $('#missionCoordinates').textContent = coords(context.site);
    $('#missionWindowHours').value = Math.round((context.window.end - context.window.start) / HOUR); $('#missionWindowHours').disabled = context.window.source === 'search';
    // Apollo 11 durations by default.
    $('#missionOutbound').value = APOLLO.outboundHours; $('#missionInbound').value = APOLLO.inboundHours; $('#missionStay').value = Math.min(APOLLO.stayHours, (context.window.end - context.window.start) / HOUR); $('#missionStay').max = (context.window.end - context.window.start) / HOUR;
    $('#missionCamera').value = 'auto'; $('#missionSceneMessage').textContent = ''; $('#missionError').textContent = '';
    this.dialog.showModal();
    // A disposed WebGL context cannot be reused until asynchronously restored:
    // each reopened scene gets a fresh canvas with the same attributes.
    const canvas = $('#missionCanvas'), fresh = canvas.cloneNode(false); canvas.replaceWith(fresh);
    // The spacecraft are NASA's own models; they load once, the first time the mission opens.
    $('#missionSceneMessage').textContent = t('mission.loading');
    const nasa = await loadNasaModels();
    if (!this.dialog.open || this.context !== context) return;
    // Building the scene and its shaders takes a few seconds: say so, and let the message paint first.
    this.preparing = t('mission.preparing'); $('#missionSceneMessage').textContent = this.preparing;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!this.dialog.open || this.context !== context) return;
    // The scene is exposed only once built: a language change meanwhile must not reach a half-built scene.
    let scene = null;
    const show = k => { if (this.pending === scene || this.scene === scene) $('#missionSceneMessage').textContent = `${this.preparing} ${Math.round(k * 100)}%`; };
    try {
      scene = this.pending = new MissionScene(fresh, $('#missionViewport'), context.terrain, text => { $('#missionSceneMessage').textContent = text; }, { t, nasa });
      await scene.build(k => show(k * .6));
      if (this.pending !== scene || !this.dialog.open || this.context !== context) return;
      this.pending = null; this.scene = scene;
    }
    catch { if (this.pending === scene) { this.pending = null; scene?.dispose(); } $('#missionSceneMessage').textContent = t('mission.noScene'); }
    this.apply();
    // Warm-up, while the message shows: one picture of each setting (space near the Earth, lunar orbit, the descent,
    // the lunar liftoff, the entry, the sea) compiles its shaders now instead of stalling the playback later.
    if (this.scene && this.plan) {
      const warm = [['launch', .5], ['lunarOrbit', .5], ['descent', .8], ['ascent', .3], ['ascent', .72], ['ascent', .92], ['lunarReturnOrbit', .3], ['arrival', .5], ['splashdown', .7]];
      for (const [i, [id, k]] of warm.entries()) {
        const phase = PHASES.find(p => p.id === id); if (!phase) continue; show(.6 + .4 * i / warm.length);
        // (Each setting also captures its reflections: the first capture in a setting compiles what it needs, ~1 s.)
        this.progress = phase.start + (phase.end - phase.start) * k; this.draw(true); this.scene.reflectionAge = 1e9; this.scene.frameNow();
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (!this.dialog.open || this.context !== context || !this.scene) return;
      }
      this.progress = 0; this.draw(true);
      if ($('#missionSceneMessage').textContent.startsWith(this.preparing)) $('#missionSceneMessage').textContent = '';
    }
    this.tick = now => {
      if (!this.dialog.open) return;
      const dt = Math.min(5000, now - this.last); this.last = now;
      if (this.playing && !document.hidden) {
        this.progress = Math.min(1, this.progress + dt / (ANIMATION_SECONDS * 1000) * Number($('#missionSpeed').value));
        const finished = this.progress >= 1; if (finished) this.stop();
        if (finished || now - this.lastDraw >= 33) { this.lastDraw = now; this.draw(); }
      }
      this.frame = requestAnimationFrame(this.tick);
    };
    this.frame = requestAnimationFrame(this.tick);
  }
  apply(keepProgress = false) {
    const keep = this.progress; this.stop(); const c = this.context, duration = Number($('#missionWindowHours').value);
    try {
      if (c.window.source !== 'search' && (!Number.isInteger(duration) || duration < 1 || duration > 720)) throw new Error(t('mission.errorWindow'));
      const end = c.window.source === 'search' ? c.window.end : new Date(+c.window.start + duration * HOUR);
      const plan = buildMission({ site: c.site, windowStart: c.window.start, windowEnd: end, outboundHours: Number($('#missionOutbound').value), stayHours: Number($('#missionStay').value), inboundHours: Number($('#missionInbound').value), elevationKm: c.terrain.elevationKm }, this.astronomy);
      this.plan = plan; this.progress = keepProgress ? keep : 0; this.conditionKey = ''; this.error = null; $('#missionError').textContent = ''; $('#missionStay').max = (end - c.window.start) / HOUR;
      $('#missionWindowSource').textContent = t(c.window.source === 'search' ? 'mission.windowSearch' : 'mission.windowManual');
      $('#missionWindowStart').textContent = utcDate(c.window.start, true); $('#missionWindowEnd').textContent = t('mission.until', { date: utcDate(end, true) });
      $('#missionEvents').innerHTML = [['launch', plan.launch], ['tli', plan.times.tli[0]], ['loi', plan.times.loi[0]], ['landing', plan.arrival], ['departure', plan.departure], ['tei', plan.times.tei[0]], ['entry', plan.times.arrival[0]], ['return', plan.returnAt]]
        .map(([id, time]) => `<div><dt>${t(`event.${id}`)}</dt><dd class="num">${utcDate(time)}</dd></div>`).join('');
      $('#missionOrbitSummary').innerHTML = [['earth', plan.earthParking, 6378.137], ['moon', plan.lunarParking, 1737.4]]
        .map(([body, orbit, radius]) => `<div><b>${t(`orbit.${body}`)} · ${number(Math.round(orbit.radiusKm - radius))} km</b><span class="num">${t('orbit.period', { min: number(orbit.periodSeconds / 60, 1), speed: number(orbit.speedKmS, 2) })}</span><small>${t(`orbit.${body}Note`, { before: plan.lunarTurns, after: plan.lunarReturnTurns })}</small></div>`).join('');
      let total = 0, good = 0;
      for (let h = 0; h < plan.stayHours; h++) { const m = evaluate(c.site, new Date(plan.arrival + h * HOUR), c.terrain, this.astronomy, c.heightM, c.panel); total++; if (m.sun.available && m.earth.available) good++; }
      const last = evaluate(c.site, new Date(plan.departure), c.terrain, this.astronomy, c.heightM, c.panel); total++; if (last.sun.available && last.earth.available) good++;
      $('#missionAssessment').textContent = (good === total ? t('mission.good', { n: total }) : t('mission.warn', { good, total }))
        + (plan.returnShiftHours ? ` ${t('mission.returnShift', { h: `${plan.returnShiftHours > 0 ? '+' : '−'}${number(Math.abs(plan.returnShiftHours), 1)}` })}` : '');
      $('#missionAssessment').classList.toggle('warning', good !== total);
      this.scene?.setPlan(plan); this.draw(true);
    } catch (error) { this.error = error; $('#missionError').textContent = error.code ? t(error.code) : error.message; }
  }
  draw(reset = false) {
    if (!this.plan) return;
    const s = sampleMission(this.plan, this.progress, this.astronomy), c = this.context;
    const key = Math.floor(+s.date / 60000);
    if (key !== this.conditionKey) { this.conditionKey = key; this.conditions = evaluate(c.site, s.date, c.terrain, this.astronomy, c.heightM, c.panel); }
    this.scene?.update(s, this.conditions, reset);
    $('#missionPhase').textContent = t(`phase.${s.phase}`); $('#missionClock').textContent = utcDate(s.date, true);
    $('#missionElapsed').textContent = `${number(s.elapsedHours, 1)} h`;
    $('#missionDistance').textContent = `${number(Math.round(s.distanceKm))} km`;
    $('#missionAltitude').textContent = `${s.altitudeKm < 1 ? `${number(s.altitudeKm * 1000)} m` : `${number(Math.round(s.altitudeKm))} km`} ${t(`alt.${s.altitudeReference}`)}`;
    $('#missionConditions').textContent = t('cond', { sun: t(this.conditions.sun.available ? 'cond.visible' : 'cond.blocked'), earth: t(this.conditions.earth.available ? 'cond.visible' : 'cond.blocked') });
    // The rendezvous says what is happening: the CSM's range on the climb, the gap to it, docked, cast off, the turn.
    const pair = s.pair, range = km => km < 1 ? `${number(Math.round(km * 1000))} m` : `${number(km, km < 10 ? 1 : 0)} km`;
    const meeting = !pair?.status ? '' : pair.status === 'climb' ? t('ms.climb', { d: range(pair.rangeKm) }) : t(`ms.${pair.status}`, { d: range(pair.gapKm) });
    const status = s.orbit
      ? t('ms.orbit', { turns: number(s.orbitTurns, 2), total: number(s.orbit.turns, 2), speed: number(s.orbit.speedKmS, 2) }) + (s.orbit.turns > 2 && !meeting ? ` · ${t(s.phase === 'lunarOrbit' ? 'ms.finalArc' : 'ms.oneLap')}` : '')
      : s.engine ? t(['tli', 'loi', 'tei'].includes(s.phase) ? 'ms.burn' : 'ms.thrust') : t(s.phase === 'surface' ? 'ms.surface' : 'ms.flight');
    $('#missionOrbitStatus').textContent = !meeting ? status : pair.status === 'climb' ? `${status} · ${meeting}` : `${meeting} · ${status}`;
    $('#missionProgress').value = Math.round(this.progress * 1000);
    document.querySelectorAll('[data-mission-phase]').forEach(b => {
      const phase = PHASES.find(p => p.id === b.dataset.missionPhase);
      b.classList.toggle('active', phase.id === s.phase); b.classList.toggle('done', this.progress >= phase.end);
      b.setAttribute('aria-pressed', String(phase.id === s.phase));
    });
    this.sample = s;
  }
  playButton() { if (this.scene) this.scene.playing = this.playing; const b = $('#missionPlay'); b.setAttribute('aria-pressed', String(this.playing)); b.setAttribute('aria-label', t(this.playing ? 'mp.pause' : 'mp.play')); }
  stop() { this.playing = false; this.playButton(); }
}
