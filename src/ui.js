// HUD, input handling, object info, search, time controls and labels.
import { V, Q, C, clamp } from './math.js';
import { targetName, findByName, searchList, solSystem, systemFor } from './nav.js';
import { describeBody } from './system.js';
import { starName } from './system.js';
import { galaxyName, REAL_GALAXIES } from './universe.js';
import { rcfg } from './render.js';
import { cfg as planetCfg } from './planet.js';
import { RNG } from './rng.js';
import { visibleNebulae, nebulaAt } from './exotic.js';
import { catalog, loadCatalog } from './assets.js';
import { SUN_POS, MILKY_WAY } from './universe.js';
import { Tour } from './tour.js';
import { nextEclipse } from './eclipses.js';
import { world, YEAR, updateWorld } from './galdyn.js';
import { cosmo, galaxyView, apparentPosU, galaxyInfo } from './cosmology.js';
import { LG, LG_START, updateLocalGroupPositions, M31, lgWeights } from './localgroup.js';
import { SandboxUI } from './sandboxui.js';
import { R0 as LG_R0, V0 as LG_V0, ORBIT as LG_ORBIT } from './lgorbit.js';
import { RATES, fmtRate, fmtSimDate, fmtSpan, Timeline, MAX_T } from './timeline.js';
import { sunState, earthDay, moonScale, engulfed, geologicPeriod } from './evolution.js';

export function fmtDist(m) {
  const a = Math.abs(m);
  if (a < 1000) return m.toFixed(a < 10 ? 2 : 0) + ' m';
  if (a < 1e9) return (m / 1e3).toLocaleString('en', { maximumFractionDigits: a < 1e6 ? 2 : 0 }) + ' km';
  if (a < 0.01 * C.AU) return (m / 1e6).toLocaleString('en', { maximumFractionDigits: 0 }) + ' Mm';
  if (a < 2e4 * C.AU) return (m / C.AU).toPrecision(4) + ' AU';
  if (a < 3.26 * C.LY * 1e3) return (m / C.LY).toPrecision(4) + ' ly';
  if (a < C.PC * 1e6) return (m / C.PC / 1e3).toPrecision(4) + ' kpc';
  if (a < C.PC * 1e9) return (m / C.PC / 1e6).toPrecision(4) + ' Mpc';
  return (m / C.PC / 1e9).toPrecision(4) + ' Gpc';
}
export function fmtSpeed(v) {
  if (v < 1000) return v.toFixed(v < 10 ? 1 : 0) + ' m/s';
  if (v < 0.01 * C.c) return (v / 1e3).toLocaleString('en', { maximumFractionDigits: v < 1e5 ? 2 : 0 }) + ' km/s';
  if (v < 1000 * C.c) return (v / C.c).toPrecision(3) + ' c';
  if (v < C.LY * 1000) return (v / C.LY).toPrecision(3) + ' ly/s';
  if (v < C.PC * 1e6) return (v / C.PC / 1e3).toPrecision(3) + ' kpc/s';
  return (v / C.PC / 1e6).toPrecision(3) + ' Mpc/s';
}
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

export class UI {
  constructor(nav, renderer, canvas) {
    this.nav = nav; this.r = renderer; this.canvas = canvas; this.fps = 0;
    this.keys = new Set(); this.acc = { lookX: 0, lookY: 0, orbitX: 0, orbitY: 0, wheel: 0, zoom: 0 };
    this.showLabels = true; this.hidden = false;
    const root = this.root = document.getElementById('ui');
    root.innerHTML = '';
    this.info = root.appendChild(el('div', 'panel info'));
    this.top = root.appendChild(el('div', 'panel top'));
    this.top.innerHTML = `<input id="search" placeholder="Search: Saturn, Andromeda, dinosaurs, 2 Gyr…" autocomplete="off" list="searchlist"><datalist id="searchlist"></datalist>
      <select id="places" title="Places"><option value="">Places…</option></select>
      <button id="bGo" title="Go to selection (G)">Go to</button><button id="bLand" title="Land on selection (L)">Land</button><button id="bOrbit" title="Enter a circular orbit around the nearest body (Y)">Orbit</button><button id="bSys" title="System browser (Tab)">System</button><button id="bTour" title="Guided tour (T)">Tour</button><button id="bSandbox" title="Physics sandbox: black holes, neutron stars, gravitational waves (V)">Sandbox</button><select id="marks" title="Saved views (B saves the current one)"><option value="">Saved…</option></select><select id="bRand" title="Travel somewhere new"><option value="">Explore…</option><option value="star">Random star</option><option value="earthlike">Earth-like planet with life</option><option value="rings">Ringed planet</option><option value="giant-star">Giant star</option><option value="galaxy">Another galaxy</option></select><button id="bSet" title="Settings">⚙</button><button id="bHelp" title="Help (H)">?</button>`;
    this.status = root.appendChild(el('div', 'panel status'));
    this.timebar = root.appendChild(el('div', 'panel time'));
    this.timebar.innerHTML = `<button id="tRev" title="Reverse (J)">⏪</button><button id="tSlow" title="Slower (,)">−</button><button id="tPause" title="Pause (Space)">⏸</button><button id="tFast" title="Faster (.)">+</button><button id="tReal" title="Real time (\\)">1×</button><select id="tRate" title="Time rate"><option value="">Rate…</option><option value="0.01">Slow motion 1/100</option><option value="1">Real time</option><option value="60">1 minute/s</option><option value="3600">1 hour/s</option><option value="86400">1 day/s</option><option value="2629800">1 month/s</option><option value="31557600">1 year/s</option><option value="3155760000">100 years/s</option><option value="3.15576e10">1,000 years/s</option><option value="3.15576e11">10,000 years/s</option><option value="3.15576e12">100,000 years/s</option><option value="3.15576e13">1 million years/s</option><option value="3.15576e14">10 million years/s</option><option value="3.15576e15">100 million years/s</option><option value="3.15576e16">1 billion years/s</option><option value="3.15576e17">10 billion years/s</option></select><button id="tNow" title="Current date">Now</button><button id="tDate" title="Set date and time">Date</button><button id="tEcl" title="Go to the next solar or lunar eclipse (E: next)">Eclipse</button><button id="tLine" title="Timeline from the Big Bang to the far future (U)">Timeline</button><button id="bShare" title="Copy a link to this place and time">Link</button><span id="tText"></span>
      <input id="tDateIn" type="datetime-local" step="60" class="hidden">`;
    this.labels = root.appendChild(el('div', 'labels'));
    this.perf = root.appendChild(el('div', 'panel perf hidden'));
    this.marker = root.appendChild(el('div', 'marker'));
    this.sysPanel = root.appendChild(el('div', 'panel sys hidden'));
    this.linePanel = root.appendChild(el('div', 'panel timeline hidden'));
    this.setPanel = root.appendChild(el('div', 'panel settings hidden'));
    this.help = root.appendChild(el('div', 'panel help hidden'));
    this.help.innerHTML = `<h2>Cosmos</h2><p>A procedural universe at 1:1 scale. Everything you see can be visited.</p>
      <table>
      <tr><td>Left drag</td><td>Look around</td></tr><tr><td>Right drag</td><td>Orbit the selected object</td></tr>
      <tr><td>Wheel</td><td>Change flight speed (Ctrl + wheel: zoom to selection)</td></tr>
      <tr><td>W A S D, R F</td><td>Fly (Shift faster, Ctrl slower)</td></tr><tr><td>Q E, arrows</td><td>Roll, turn</td></tr>
      <tr><td>Click / double click</td><td>Select / go to object</td></tr><tr><td>G, L, C</td><td>Go to, land on, look at selection</td></tr>
      <tr><td>Space , . J \\</td><td>Pause, slower, faster, reverse, real time</td></tr><tr><td>&lt; &gt; Home</td><td>Speed three steps at a time; back to the present</td></tr>
      <tr><td>T</td><td>Guided tour (T again: next stop)</td></tr><tr><td>0 – 9</td><td>Sun, Mercury … Pluto</td></tr><tr><td>Y</td><td>Orbit mode: circular orbit, W A S D R F thrust</td></tr><tr><td>Shift+E</td><td>Next solar or lunar eclipse</td></tr><tr><td>U</td><td>Timeline of future events</td></tr><tr><td>V</td><td>Physics sandbox: black holes, neutron stars, gravitational waves</td></tr><tr><td>M</td><td>Relativistic flight: below light speed, with aberration, Doppler shift, beaming, time dilation</td></tr><tr><td>Rate menu</td><td>Slow motion to 10 billion years per second</td></tr><tr><td>B</td><td>Save this view (Saved menu)</td></tr><tr><td>Tab</td><td>System browser</td></tr><tr><td>O, N, K</td><td>Toggle orbits, labels, constellations</td></tr>
      <tr><td>[ ]</td><td>Exposure down / up</td></tr><tr><td>Z X</td><td>Zoom field of view</td></tr><tr><td>F2, F3</td><td>Hide interface, GPU timings</td></tr><tr><td>P</td><td>Save screenshot</td></tr>
      </table>
      <h3 style="margin-top:12px">Physics and deep time</h3>
      <p class="dim">The Rate menu (or , . &lt; &gt;) runs the clock from slow motion to 10 billion years per second, forwards or back (J).
      The Timeline (U) runs from the Big Bang to the last stars; Go jumps to an event, and the search box takes events
      ("dinosaurs") and times ("2 Gyr", "year 3000", "age 380 kyr"). What changes with time:</p>
      <ul class="dim physlist">
        <li><b>The universe</b>: expansion, redshift and the event horizon; galaxies form, start small, blue and star-bursting, then age and fade; supernovae flare in other galaxies; the early cosmos glows (try "age 380 kyr").</li>
        <li><b>The Galaxy</b>: stars orbit and stream, the spiral pattern turns, massive stars explode and their remnants expand, nebulae form and disperse, Andromeda collides with us.</li>
        <li><b>Stars</b>: every star you visit ages (main sequence, giant, white dwarf, neutron star or black hole); Betelgeuse, Rigel and six other real stars explode on estimated dates; Miras and Cepheids pulsate; red dwarfs flare; the S-stars orbit Sagittarius A*.</li>
        <li><b>The Sun</b>: its birth in a dusty disk, 11-year cycle, slow brightening, red giant, planetary nebula and white dwarf.</li>
        <li><b>The planets</b>: orbits precess and change shape (secular theory), planets are swallowed or heated by the giant Sun, Phobos and Triton break into rings, Saturn's rings rain away, Mars once had an ocean.</li>
        <li><b>Earth</b>: magma ocean, bare continents before land plants, Snowball Earth, ice ages paced by its orbit (sea level and ice sheets), drifting continents, a lengthening day and receding Moon, precession, and the oceans boiling away in a billion years.</li>
        <li><b>The sandbox (V)</b>: N-body gravity with general relativity: merging black holes (Kerr shadows, gravitational waves you can hear), neutron star mergers and kilonovae, tidal disruption, the Moon-forming impact, Type Ia supernovae.</li>
      </ul>
      <p class="dim">Near a planet, fast time-lapses advance in whole days and orbits so the view holds still. M toggles relativistic flight.</p>
      <h3 style="margin-top:12px">Data and credits</h3>
      <p class="dim credits">Earth: NASA Blue Marble NG, Black Marble 2016, Blue Marble clouds (NASA Earth Observatory); ETOPO 2022 (NOAA); Natural Earth. Past continents: PALEOMAP PaleoDEMs, Scotese &amp; Wright (2018), CC BY 4.0.
      Moon: LRO LROC WAC and LOLA (NASA SVS CGI Moon Kit). Mars: Viking MDIM 2.1 and MOLA (USGS Astrogeology). Mercury, moons, Pluto, Ceres: USGS Astrogeology mosaics from MESSENGER, Galileo, Voyager, Cassini, New Horizons and Dawn.
      Gas giants, Venus clouds and Saturn's rings: Solar System Scope textures (CC BY 4.0).
      Stars: HYG database v4.4, David Nash / astronexus.com (CC BY-SA 4.0). Constellation figures: Stellarium (GPL).
      Milky Way: ESO/S. Brunier panorama (CC BY 4.0). Exoplanets: NASA Exoplanet Archive.
      Ephemerides: JPL approximate planetary elements (E. M. Standish), J. Meeus, Astronomical Algorithms.
      Plate boundaries: P. Bird (2003), PB2002 (via github.com/fraxen/tectonicplates); plate motions NNR-NUVEL-1A (DeMets et al. 1994).</p>
      <p class="dim">Press H or ? to close.</p>`;
    // one-time note about the physics features
    try {
      if (!localStorage.getItem('cosmos.seen.physics') && !new URLSearchParams(location.search).has('test')) {
        localStorage.setItem('cosmos.seen.physics', '1');
        setTimeout(() => {
          const n = root.appendChild(el('div', 'panel whatsnew', `<b>New: physics across all of time</b><div>V opens the sandbox: merge black holes and hear the gravitational waves, or watch the Moon form.</div><div>U opens the timeline: Betelgeuse's supernova, Andromeda's collision, the Sun's red giant phase.</div><div>The Rate menu runs the clock up to 10 billion years per second: watch ice ages come and go and the continents drift. M flies at relativistic speed.</div><button>OK</button>`));
          n.querySelector('button').onclick = () => n.remove(); setTimeout(() => n.remove(), 25000);
        }, 2500);
      }
    } catch (e) { }
    this.hint = root.appendChild(el('div', 'hint', 'Drag to look · W A S D to fly · double click to travel · <b>V</b> physics sandbox · <b>U</b> timeline · <b>H</b> help'));
    setTimeout(() => this.hint.classList.add('fade'), 9000);
    // on-screen fly buttons for touch screens
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
      const pad = root.appendChild(el('div', 'pad'));
      for (const [label, key] of [['▲', 'w'], ['▼', 's']]) {
        const b = pad.appendChild(el('button', '', label));
        const on = (e) => { e.preventDefault(); this.keys.add(key); }, off = (e) => { e.preventDefault(); this.keys.delete(key); };
        b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointerleave', off); b.addEventListener('pointercancel', off);
      }
    }
    this.buildSettings();
    this.bind();
    this.lastInfoKey = null; this.labelPool = []; this.sysKey = null;
    const fillSearch = () => { document.getElementById('searchlist').innerHTML = searchList(nav).concat(this.timeline ? this.timeline.events.map(e => e.title) : []).map(n => `<option value="${n}">`).join(''); };
    fillSearch(); loadCatalog().then(fillSearch);
  }
  saveSettings() {
    try { localStorage.setItem('cosmos.settings', JSON.stringify({ exposureBias: rcfg.exposureBias, bloom: rcfg.bloom, clouds: rcfg.clouds, orbits: rcfg.orbits, fxaa: rcfg.fxaa, flare: rcfg.flare, autoScale: rcfg.autoScale, constellations: rcfg.constellations, labels: this.showLabels, fov: this.nav.fov })); } catch (e) { }
  }
  loadSettings() {
    try { const o = JSON.parse(localStorage.getItem('cosmos.settings') || 'null'); if (!o) return; for (const k of ['exposureBias', 'bloom', 'clouds', 'orbits', 'fxaa', 'flare', 'autoScale', 'constellations']) if (o[k] !== undefined) rcfg[k] = o[k]; if (o.labels !== undefined) this.showLabels = o.labels; if (o.fov) this.nav.fov = o.fov; } catch (e) { }
  }
  buildSettings() {
    this.loadSettings();
    const s = this.setPanel;
    s.innerHTML = `<h3>Settings</h3>
      <label>Exposure bias <input type="range" id="sExp" min="-6" max="6" step="0.25" value="${rcfg.exposureBias}"><span id="sExpV">${rcfg.exposureBias} EV</span></label>
      <label>Bloom <input type="range" id="sBloom" min="0" max="0.2" step="0.005" value="${rcfg.bloom}"></label>
      <label>Field of view <input type="range" id="sFov" min="5" max="110" step="1" value="${Math.round(this.nav.fov * 180 / Math.PI)}"><span id="sFovV">${Math.round(this.nav.fov * 180 / Math.PI)}°</span></label>
      <label>Render scale <input type="range" id="sScale" min="0.4" max="2" step="0.1" value="${rcfg.scale}"><span id="sScaleV">${rcfg.scale}</span></label>
      <label><input type="checkbox" id="sClouds" ${rcfg.clouds ? 'checked' : ''}> Volumetric clouds</label>
      <label><input type="checkbox" id="sOrbits" ${rcfg.orbits ? 'checked' : ''}> Orbits</label>
      <label><input type="checkbox" id="sLabels" ${this.showLabels ? 'checked' : ''}> Labels</label>
      <label><input type="checkbox" id="sConst" ${rcfg.constellations ? 'checked' : ''}> Constellations</label>
      <label><input type="checkbox" id="sAuto" checked> Auto exposure</label>
      <label><input type="checkbox" id="sFxaa" ${rcfg.taa ? 'checked' : ''}> Temporal anti-aliasing</label>
      <label><input type="checkbox" id="sTrees" ${planetCfg.trees ? 'checked' : ''}> Trees</label>
      <label><input type="checkbox" id="sFlare" ${rcfg.flare ? 'checked' : ''}> Lens flare</label>
      <label><input type="checkbox" id="sAutoScale" ${rcfg.autoScale ? 'checked' : ''}> Dynamic resolution</label>
      <button id="sBench" style="margin:6px 0">Run benchmark (about 2 min)</button>
      <label>Quality <select id="sQual"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="ultra">Ultra</option></select> <span class="dim">(reloads)</span></label>`;
    const q = (id) => s.querySelector('#' + id);
    q('sExp').oninput = (e) => { rcfg.exposureBias = +e.target.value; q('sExpV').textContent = e.target.value + ' EV'; };
    q('sBloom').oninput = (e) => { rcfg.bloom = +e.target.value; };
    q('sFov').oninput = (e) => { this.nav.fov = +e.target.value * Math.PI / 180; q('sFovV').textContent = e.target.value + '°'; };
    q('sScale').oninput = (e) => { rcfg.scale = +e.target.value; q('sScaleV').textContent = e.target.value; };
    q('sClouds').onchange = (e) => { rcfg.clouds = e.target.checked; };
    q('sOrbits').onchange = (e) => { rcfg.orbits = e.target.checked; };
    q('sLabels').onchange = (e) => { this.showLabels = e.target.checked; };
    q('sConst').onchange = (e) => { rcfg.constellations = e.target.checked; };
    q('sAuto').onchange = (e) => { rcfg.autoExposure = e.target.checked; rcfg.manualExposure = this.r.exposure; };
    q('sFxaa').onchange = (e) => { rcfg.taa = e.target.checked; };
    q('sFlare').onchange = (e) => { rcfg.flare = e.target.checked; };
    q('sTrees').onchange = (e) => { planetCfg.trees = e.target.checked; };
    q('sAutoScale').onchange = (e) => { rcfg.autoScale = e.target.checked; };
    q('sBench').onclick = () => { this.setPanel.classList.add('hidden'); import('./bench.js').then(m => m.runBenchmark(window.cosmos)); };
    q('sQual').value = rcfg.quality || 'high';
    s.addEventListener('input', () => this.saveSettings()); s.addEventListener('change', () => this.saveSettings());
    q('sQual').onchange = (e) => { const u = new URL(location.href); u.searchParams.set('q', e.target.value); location.href = u.toString(); };
  }
  bind() {
    const c = this.canvas, nav = this.nav;
    let down = null, moved = 0;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => { c.setPointerCapture(e.pointerId); document.activeElement && document.activeElement.blur(); if (e.button === 0 && this.sbui && this.sbui.pointer('down', e.clientX, e.clientY)) { down = { b: -1 }; return; } down = { b: e.button, x: e.clientX, y: e.clientY }; moved = 0; });
    c.addEventListener('pointermove', e => {
      if (!down) return;
      if (down.b === -1) { this.sbui.pointer('move', e.clientX, e.clientY); return; }
      const dx = e.movementX, dy = e.movementY; moved += Math.abs(dx) + Math.abs(dy);
      if (down.b === 2 || e.altKey) { this.acc.orbitX += dx; this.acc.orbitY += dy; } else { this.acc.lookX -= dx; this.acc.lookY -= dy; }
    });
    c.addEventListener('pointerup', e => {
      if (down && down.b === -1) { this.sbui.pointer('up', e.clientX, e.clientY); down = null; return; }
      if (down && moved < 5 && down.b === 0) this.click(e.clientX, e.clientY, e.detail >= 2);
      down = null;
    });
    c.addEventListener('wheel', e => { e.preventDefault(); if (e.ctrlKey || e.shiftKey) this.acc.zoom += e.deltaY; else this.acc.wheel += e.deltaY; }, { passive: false });
    // touch pinch = fly forward/back
    let pinch = 0; this.pinchMove = 0;
    c.addEventListener('touchmove', e => { if (e.touches.length === 2) { const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); if (pinch) this.acc.zoom -= (d - pinch) * 3; pinch = d; } }, { passive: true });
    c.addEventListener('touchend', () => { pinch = 0; });
    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') { if (e.key === 'Enter') { this.search(e.target.value); e.target.blur(); } if (e.key === 'Escape') e.target.blur(); return; }
      const k = e.key.toLowerCase(); this.keys.add(k);
      if (k === 'tab') { e.preventDefault(); this.toggle(this.sysPanel); }
      else if (k === 'g') nav.goTo(nav.selected);
      else if (k === 'c') nav.lookTarget = nav.selected;
      else if (k === 'b') this.saveMark();
      else if (k === 'y') this.toggleOrbit();
      else if (k === 'u') this.toggle(this.linePanel);
      else if (k === 'v') this.sbui.toggle();
      else if (k === 'm') { nav.relativistic = !nav.relativistic; this.toast(nav.relativistic ? 'Relativistic flight: speed below c, with aberration, Doppler shift, beaming and time dilation' : 'Relativistic flight off'); }
      else if (k === 'e' && e.shiftKey) this.goNextEclipse();
      else if (k >= '0' && k <= '9' && !e.ctrlKey && !e.altKey) this.search(['Sun', 'Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'][+k]);
      else if (k === 'l') { if (nav.selected && nav.selected.type === 'body') nav.land(nav.selected.body); }
      else if (k === ' ') { e.preventDefault(); nav.paused = !nav.paused; }
      else if (k === '.') this.stepRate(1); else if (k === ',') this.stepRate(-1);
      else if (k === '>') this.stepRate(3); else if (k === '<') this.stepRate(-3);
      else if (k === 'home') { nav.time = (Date.now() - Date.UTC(2000, 0, 1, 12)) / 1000; nav.rate = 1; nav.paused = false; this.timeline.lastTyr = nav.time / YEAR; this.toast('Back to the present'); }
      else if (k === 'j') nav.rate = -nav.rate; else if (k === '\\') { nav.rate = 1; nav.paused = false; }
      else if (k === 'h' || k === '?') this.toggle(this.help);
      else if (k === 'k') rcfg.constellations = !rcfg.constellations;
      else if (k === 'o') rcfg.orbits = !rcfg.orbits; else if (k === 'n') this.showLabels = !this.showLabels;
      else if (k === '[') rcfg.exposureBias -= 0.5; else if (k === ']') rcfg.exposureBias += 0.5;
      else if (k === 't') { if (this.tour.active) this.tour.next(); else this.tour.start(); }
      else if (k === 'escape') { if (this.tour.active) this.tour.stop(); nav.goto = null; [this.sysPanel, this.setPanel, this.help, this.linePanel].forEach(p => p.classList.add('hidden')); }
      else if (k === 'f3' || (k === 'p' && e.shiftKey)) { e.preventDefault(); rcfg.gpuTimes = !rcfg.gpuTimes; this.perf.classList.toggle('hidden', !rcfg.gpuTimes); }
      else if (k === 'f2') { e.preventDefault(); this.hidden = !this.hidden; this.root.classList.toggle('hide', this.hidden); }
      else if (k === 'p') this.screenshot();
      else if (k === '/') { e.preventDefault(); document.getElementById('search').focus(); }
    });
    window.addEventListener('keyup', e => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
    const $ = (id) => document.getElementById(id);
    $('bGo').onclick = () => nav.goTo(nav.selected);
    $('bLand').onclick = () => { if (nav.selected && nav.selected.type === 'body') nav.land(nav.selected.body); };
    $('bSys').onclick = () => this.toggle(this.sysPanel);
    this.toggleOrbit = () => { if (nav.orbit) { nav.orbit = null; this.toast('Orbit mode off'); } else if (nav.enterOrbit()) this.toast('In orbit around ' + nav.orbit.body.name + ': W A S D R F fire thrusters, time controls speed it up'); else this.toast('Get close to a planet or moon first'); };
    $('bOrbit').onclick = this.toggleOrbit;
    $('bSet').onclick = () => this.toggle(this.setPanel);
    $('bHelp').onclick = () => this.toggle(this.help);
    $('bRand').onchange = (e) => { const v = e.target.value; e.target.value = ''; e.target.blur(); if (v) this.explore(v); };
    this.tour = new Tour(nav, this);
    this.timeline = new Timeline(nav, this);
    this.timeline.onGo = (e) => this.eventView(e);
    this.sbui = new SandboxUI(this);
    $('bSandbox').onclick = () => this.sbui.toggle();
    $('tLine').onclick = () => this.toggle(this.linePanel);
    $('bTour').onclick = () => { if (this.tour.active) this.tour.stop(); else this.tour.start(); };
    $('search').addEventListener('change', e => { this.search(e.target.value); });
    const groups = { 'Solar System': ['Sun', 'Mercury', 'Venus', 'Earth', 'Moon', 'Mars', 'Jupiter', 'Io', 'Europa', 'Saturn', 'Titan', 'Enceladus', 'Uranus', 'Neptune', 'Triton', 'Pluto', "Halley's Comet", 'Comet Hale-Bopp', 'Comet NEOWISE'],
      'Exoplanets': ['Proxima Centauri', 'TRAPPIST-1', 'Helvetios', 'Ran', 'Tau Ceti', "Barnard's Star", 'Sirius'],
      'Nebulae': ['Orion Nebula', 'Lagoon Nebula', 'Carina Nebula', 'Ring Nebula', 'Crab Nebula', 'Veil Nebula'],
      'Supernova remnants': ['Crab Nebula', 'Cassiopeia A', "Tycho's supernova remnant", "Kepler's supernova remnant", 'SN 1006 remnant', 'RCW 86 (SN 185)'],
      'Black holes and pulsars': ['Sagittarius A*', 'Cygnus X-1', 'Crab Pulsar'],
      'Interstellar visitors': ["1I/'Oumuamua", '2I/Borisov', '3I/ATLAS'],
      'Stars passing the Sun': ["Scholz's Star", "Barnard's Star", 'Gliese 710', 'Rigil Kentaurus'],
      'Star clusters': ['Omega Centauri', '47 Tucanae', 'M13 (Hercules Cluster)', 'M22', 'M4'],
      'Galaxies': ['Milky Way', 'Andromeda Galaxy (M31)', 'Triangulum Galaxy (M33)', 'Large Magellanic Cloud', 'Whirlpool Galaxy (M51)', 'Sombrero Galaxy (M104)', 'Messier 87', 'Centaurus A'] };
    $('places').innerHTML = '<option value="">Places…</option>' + Object.entries(groups).map(([g, l]) => `<optgroup label="${g}">${l.map(n => `<option>${n}</option>`).join('')}</optgroup>`).join('');
    $('places').onchange = (e) => { if (e.target.value) this.search(e.target.value); e.target.value = ''; e.target.blur(); };
    $('tPause').onclick = () => { nav.paused = !nav.paused; };
    $('tFast').onclick = () => this.stepRate(1); $('tSlow').onclick = () => this.stepRate(-1);
    $('tRate').onchange = (e) => { const v = +e.target.value; e.target.value = ''; e.target.blur(); if (v) { nav.rate = v * (nav.rate < 0 ? -1 : 1); nav.paused = false; } };
    $('tRev').onclick = () => { nav.rate = -nav.rate; }; $('tReal').onclick = () => { nav.rate = 1; nav.paused = false; };
    $('tNow').onclick = () => { nav.time = (Date.now() - Date.UTC(2000, 0, 1, 12)) / 1000; };
    $('tEcl').onclick = () => this.goNextEclipse();
    const din = $('tDateIn');
    $('tDate').onclick = () => {
      const d = new Date(Date.UTC(2000, 0, 1, 12) + nav.time * 1000);
      if (!isNaN(d)) din.value = d.toISOString().slice(0, 16);
      din.classList.toggle('hidden'); if (!din.classList.contains('hidden')) din.focus();
    };
    din.onchange = () => { const t = Date.parse(din.value + 'Z'); if (!isNaN(t)) nav.time = (t - Date.UTC(2000, 0, 1, 12)) / 1000; };
    const marks = $('marks');
    const loadMarks = () => { try { return JSON.parse(localStorage.getItem('cosmos.marks') || '[]'); } catch (e) { return []; } };
    const fillMarks = () => { const m = loadMarks(); marks.innerHTML = '<option value="">Saved…</option><option value="+">+ Save this view (B)</option>' + m.map((x, i) => `<option value="${i}">${x.name}</option>`).join('') + (m.length ? '<option value="-">Clear saved views</option>' : ''); };
    this.saveMark = () => {
      const link = this.locationLink(); if (!link) return;
      const name = (nav.selected ? targetName(nav.selected) : 'View') + ' · ' + new Date(Date.UTC(2000, 0, 1, 12) + nav.time * 1000).toISOString().slice(0, 10);
      const m = loadMarks(); m.push({ name, link, q: nav.q }); try { localStorage.setItem('cosmos.marks', JSON.stringify(m.slice(-40))); } catch (e) { }
      fillMarks(); this.toast('Saved: ' + name);
    };
    marks.onchange = () => {
      const v = marks.value; marks.value = ''; marks.blur();
      if (v === '+') this.saveMark();
      else if (v === '-') { try { localStorage.removeItem('cosmos.marks'); } catch (e) { } fillMarks(); }
      else if (v !== '') { const m = loadMarks()[+v]; if (m) this.applyLink(m.link); }
    };
    fillMarks();
    $('bShare').onclick = () => {
      const txt = this.locationLink();
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => this.toast('Link copied'), () => prompt('Link to this place', txt));
    };
  }
  caption(title, text, i, n) {
    if (!this.capEl) this.capEl = this.root.appendChild(el('div', 'panel caption'));
    if (!title) { this.capEl.classList.add('hidden'); return; }
    this.capEl.classList.remove('hidden');
    this.capEl.innerHTML = i === '' ? `<div class="ct">${title}</div><div>${text}</div>` : `<div class="ct">${title}<span class="dim"> · ${i}/${n}</span></div><div>${text}</div><div class="dim">T next stop · Esc ends the tour</div>`;
  }
  locationLink() {
    const nav = this.nav, u = new URL(location.href); u.search = '';
    const t = nav.selected || (nav.anchor ? { type: 'body', body: nav.anchor } : null);
    const d = new Date(Date.UTC(2000, 0, 1, 12) + nav.time * 1000), yrs = (nav.time - (Date.now() - Date.UTC(2000, 0, 1, 12)) / 1000) / YEAR;
    if (Math.abs(yrs) > 5000 || isNaN(d)) u.searchParams.set('years', yrs.toPrecision(8));
    else u.searchParams.set('date', d.toISOString().slice(0, 16) + 'Z');
    const ll = this.latLon();
    if (ll && nav.altitude < nav.anchor.radius * 0.05) { u.searchParams.set('goto', nav.anchor.name); u.searchParams.set('land', ll[0].toFixed(3) + ',' + ll[1].toFixed(3)); }
    else if (t) u.searchParams.set('goto', targetName(t));
    return u.toString();
  }
  applyLink(link) {
    const nav = this.nav, p = new URL(link).searchParams;
    if (p.has('date')) { const t = Date.parse(p.get('date')); if (!isNaN(t)) nav.time = (t - Date.UTC(2000, 0, 1, 12)) / 1000; }
    if (p.has('years')) { const y = parseFloat(p.get('years')); if (isFinite(y)) nav.time = (Date.now() - Date.UTC(2000, 0, 1, 12)) / 1000 + y * YEAR; }
    if (p.has('goto')) {
      const t = findByName(nav, p.get('goto'));
      if (t && p.has('land') && t.type === 'body') { const [la, lo] = p.get('land').split(',').map(Number); nav.landAt(t.body, la, lo); }
      else if (t) { nav.selected = t; nav.goTo(t); }
    }
  }
  // find the next central solar or umbral lunar eclipse after the current time and watch it from the best place
  goNextEclipse() {
    const nav = this.nav, sol = solSystem();
    const from = this.lastEclipse && Math.abs(nav.time - this.lastEclipse.t) < 3 * 3600 ? this.lastEclipse.t + 3 * 86400 : nav.time;
    const r = nextEclipse(sol, from);
    if (!r) { this.toast('No eclipse found in the next two years'); return; }
    this.lastEclipse = r;
    const e = sol.find('Earth'), target = sol.find(r.kind === 'solar' ? 'Sun' : 'Moon');
    nav.time = r.t - (r.kind === 'solar' ? 240 : 1800); nav.paused = false; nav.rate = r.kind === 'solar' ? 4 : 60;
    sol.update(nav.time);
    nav.landAt(e, r.lat, r.lon, {});
    nav.onArrive = () => { nav.lookTarget = { type: 'body', body: target }; nav.fov = r.kind === 'solar' ? 0.05 : 0.04; nav.selected = { type: 'body', body: target }; };
    const d = new Date(Date.UTC(2000, 0, 1, 12) + r.t * 1000).toISOString().slice(0, 16).replace('T', ' ');
    const where = Math.abs(r.lat).toFixed(1) + '° ' + (r.lat >= 0 ? 'N' : 'S') + ', ' + Math.abs(r.lon).toFixed(1) + '° ' + (r.lon >= 0 ? 'E' : 'W');
    const label = r.total ? 'Total ' : r.kind === 'solar' ? (r.central ? 'Annular or hybrid ' : 'Partial ') : (r.central ? 'Partial ' : 'Penumbral ');
    this.toast(label + r.kind + ' eclipse, ' + d + ' UTC, from ' + where);
  }
  toast(msg) { const t = this.root.appendChild(el('div', 'toast', msg)); setTimeout(() => t.classList.add('fade'), 1400); setTimeout(() => t.remove(), 3200); }
  // planetographic latitude/longitude of the camera over the anchor body (degrees)
  latLon() {
    const nav = this.nav, b = nav.anchor; if (!b || !b.wrot) return null;
    const d = Q.rot(Q.conj(b.wrot), V.norm(V.sub(nav.S, b.wpos)));
    return [Math.asin(clamp(d[1], -1, 1)) * 180 / Math.PI, Math.atan2(-d[2], d[0]) * 180 / Math.PI];
  }
  toggle(p) { const was = p.classList.contains('hidden'); [this.sysPanel, this.setPanel, this.help, this.linePanel].forEach(q => q.classList.add('hidden')); if (was && this.sbui) this.sbui.panel.classList.add('hidden'); if (was) p.classList.remove('hidden'); if (p === this.sysPanel) this.sysKey = null; if (p === this.linePanel) this.lineKey = null; }
  stepRate(d) {
    const nav = this.nav, a = Math.abs(nav.rate), sg = nav.rate < 0 ? -1 : 1;
    let i = RATES.findIndex(r => r >= a * 0.999); if (i < 0) i = RATES.length - 1;
    i = clamp(i + d, 0, RATES.length - 1); nav.rate = RATES[i] * sg; nav.paused = false;
  }
  // what visibly changes at the current time rate, given where you are
  watchHint(nav) {
    const r = Math.abs(nav.rate) / YEAR, lvl = nav.level, sys = nav.system, an = nav.anchor;
    const atEarth = an && an.name === 'Earth', sol = sys && sys.desc && sys.desc.sol, sandbox = sys && sys.sandbox;
    if (sandbox || r < 1e-4) return '';
    if (lvl === 'universe') return r < 1e5 ? '' : r < 1e8 ? 'galaxies slowly turn; supernovae flare in some; quasars switch on and off' : r < 3e9 ? 'galaxies turn, redden and recede; Andromeda and the Milky Way merge (2.6-6 Gyr ahead)' : 'galaxies recede beyond the horizon and fade as their stars die';
    if (lvl === 'galaxy') return r < 1e4 ? 'stars barely move' : r < 1e6 ? 'nearby stars drift; massive stars explode; nebulae are born, expand and fade' : r < 3e8 ? 'stars stream around the Galaxy; the spiral pattern turns; the Sun orbits the centre (218 Myr)' : 'the Galaxy turns many times; Andromeda arrives; stars fade';
    if (atEarth && nav.altitude < 1e5) return r < 0.003 ? 'the sky turns; the Moon moves through its phases' : r < 1 ? 'seasons: snow and sea ice come and go' : r < 300 ? 'the stars stay put; the Sun\'s 11-year cycle shows in the aurora; leaves turn with the seasons' : r < 3e4 ? 'precession: the pole star changes; constellations distort' : r < 3e6 ? 'ice ages advance and retreat; the magnetic field reverses; nearby stars pass; Betelgeuse explodes' : r < 3e8 ? 'continents drift (Pangaea 250 Myr ago); the day lengthens' : 'the Sun brightens: oceans boil, then the red giant';
    if (atEarth || (sol && an)) return r < 0.01 ? 'clouds and weather move; the Moon orbits' : r < 3 ? 'seasons: snow and sea ice; planets orbit' : r < 1e4 ? 'planets orbit; orbits slowly precess' : r < 3e6 ? 'ice ages and sea level; orbits change shape (Milankovitch cycles)' : r < 3e8 ? 'continents drift (Pangaea 250 Myr ago); Phobos becomes a ring; Saturn\'s rings fade' : 'the Sun brightens and swells; planets are swallowed';
    if (sys && !sol) return r < 10 ? 'planets orbit' : r < 1e6 ? 'orbits; flares and pulsations' : 'the star ages: it brightens, swells into a giant and dies (rewind: it forms in a cloud)';
    return '';
  }
  search(text) {
    const q = String(text || '').trim().toLowerCase(); if (!q) return;
    // a moment in time ("Snowball Earth", "dinosaurs", "Big Bang") or an amount of time ("2 Gyr", "year 3000")
    const evs = this.timeline.events, ev = evs.find(e => e.title.toLowerCase() === q) || (q.length > 3 && evs.find(e => e.title.toLowerCase().includes(q) || (e.text.toLowerCase().includes(q) && q.length > 5)));
    const t = findByName(this.nav, text);
    if (t) { if (this.nav.fov < 0.3) this.nav.fov = 55 * Math.PI / 180; this.nav.selected = t; this.nav.goTo(t); return; }
    if (ev) { this.timeline.go(ev); return; }
    const y = /\d/.test(q) ? parseTimeSpec(q) : null;
    if (y !== null) { this.nav.time = (Date.now() - Date.UTC(2000, 0, 1, 12)) / 1000 + y * YEAR; this.timeline.lastTyr = this.nav.time / YEAR; this.toast(fmtSimDate(this.nav.time)); return; }
    const sol = solSystem(), gone = (sol._all || []).find(b => b.gone && b.name.toLowerCase() === q);
    this.toast(gone ? gone.name + ' does not exist at this time' : 'Nothing found for "' + text + '"');
  }
  // travel to a random interesting place
  // kind: 'star' | 'earthlike' | 'rings' | 'giant-star' | 'galaxy'
  explore(kind = 'star') {
    const nav = this.nav, rng = new RNG((Math.random() * 1e9) | 0);
    if (kind === 'galaxy' || !nav.field || nav.level === 'universe') { nav.goTo({ type: 'galaxy', galaxy: rng.pick(REAL_GALAXIES.filter(g => g !== nav.galaxy)) }); return; }
    const cam = nav.camLocal();
    const want = kind === 'earthlike' ? (b) => (b.cls === 'Terra' || b.cls === 'Ocean world') && b.life
      : kind === 'rings' ? (b) => b.kind === 'planet' && b.rings && b.rings.opacity > 0.5
      : null;
    // search outward through stars around the camera; generating a system is cheap, so look at many
    for (let tries = 0; tries < 4000; tries++) {
      const d = nav.field.pick(cam, rng.dir(), 0.3);
      if (!d || d.sol || (nav.system && d.key === nav.system.desc.key)) continue;
      if (kind === 'giant-star') { if (d.star.kind === 1 || d.star.kind === 2) { nav.goTo({ type: 'star', desc: d }); this.toast('Heading to ' + d.star.cls + ' star'); return; } continue; }
      if (!want) { nav.goTo({ type: 'star', desc: d }); return; }
      const sys = systemFor(d), b = sys.bodies.find(want);
      if (b) { nav.goTo({ type: 'star', desc: d }); nav.onArrive = () => { nav.goTo({ type: 'body', body: b }); }; this.toast('Found ' + b.name + ' (' + b.cls + ')'); return; }
    }
    this.toast('Nothing like that nearby, try again');
  }
  ray(x, y) {
    const r = this.canvas.getBoundingClientRect(), nx = (x - r.left) / r.width * 2 - 1, ny = 1 - (y - r.top) / r.height * 2;
    const tanY = Math.tan(this.nav.fov / 2), tanX = tanY * r.width / r.height;
    return V.norm(Q.rot(this.nav.q, [nx * tanX, ny * tanY, -1]));
  }
  click(x, y, dbl) {
    const r = this.canvas.getBoundingClientRect();
    const pxRad = 2 * Math.tan(this.nav.fov / 2) / r.height;
    const t = this.nav.pick(this.ray(x, y), pxRad);
    if (t) { this.nav.selected = t; if (dbl) this.nav.goTo(t); }
    else if (!dbl) this.nav.selected = null;
  }
  screenshot() { const a = document.createElement('a'); a.download = 'cosmos-' + Date.now() + '.png'; a.href = this.canvas.toDataURL('image/png'); a.click(); }
  input(dt) {
    const k = this.keys, a = this.acc;
    const o = {
      lookX: a.lookX, lookY: a.lookY, orbitX: a.orbitX, orbitY: a.orbitY, wheel: a.wheel, zoom: a.zoom,
      mx: (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0), my: (k.has('r') ? 1 : 0) - (k.has('f') ? 1 : 0), mz: (k.has('s') ? 1 : 0) - (k.has('w') ? 1 : 0),
      roll: (k.has('q') ? 1 : 0) - (k.has('e') ? 1 : 0), turnX: (k.has('arrowright') ? 1 : 0) - (k.has('arrowleft') ? 1 : 0), turnY: (k.has('arrowdown') ? 1 : 0) - (k.has('arrowup') ? 1 : 0),
      fast: k.has('shift'), slow: k.has('control'),
    };
    if (k.has('z')) this.nav.fov = clamp(this.nav.fov * Math.pow(0.5, dt), 0.2 * Math.PI / 180, 2);
    if (k.has('x')) this.nav.fov = clamp(this.nav.fov * Math.pow(2, dt), 0.2 * Math.PI / 180, 2);
    a.lookX = a.lookY = a.orbitX = a.orbitY = a.wheel = a.zoom = 0;
    return o;
  }
  fatal(e) { this.root.appendChild(el('div', 'fatal', 'Error: ' + e.message)); }

  update(dt) {
    if (this.tour) this.tour.update(dt);
    if (this.timeline) this.timeline.update(dt);
    // the clock runs from the Big Bang to 100 trillion years from now
    if (this.nav.time > MAX_T) { this.nav.time = MAX_T; this.nav.paused = true; }
    if (this.nav.time < -13.79e9 * YEAR) { this.nav.time = -13.79e9 * YEAR; this.nav.paused = true; this.toast('The Big Bang: time cannot run further back'); }
    this.updateTimeline();
    if (this.sbui) this.sbui.update();
    if (this.hidden) return;
    const nav = this.nav, r = this.r;
    // status
    const loc = nav.level === 'system' ? nav.system.name : nav.level === 'galaxy' ? galaxyName(nav.galaxy) : 'Intergalactic space';
    const dstr = fmtSimDate(nav.time);
    let alt = '';
    if (nav.anchor && nav.altitude < nav.anchor.radius * 30) {
      alt = `<div><b>Altitude</b> ${fmtDist(nav.altitude)} · ${nav.anchor.name}</div>`;
      const ll = this.latLon();
      if (ll && nav.altitude < nav.anchor.radius * 0.5 && nav.anchor.kind !== 'star') {
        alt += `<div><b>Position</b> ${Math.abs(ll[0]).toFixed(3)}° ${ll[0] >= 0 ? 'N' : 'S'}, ${Math.abs(ll[1]).toFixed(3)}° ${ll[1] >= 0 ? 'E' : 'W'}</div>`;
        const b = nav.anchor, sun = b.system.stars[0];
        if (sun && b.rotPeriod && b.wrot) {
          const d = Q.rot(Q.conj(b.wrot), V.norm(V.sub(sun.wpos, b.wpos)));
          const subLon = Math.atan2(-d[2], d[0]) * 180 / Math.PI;
          let hr = 12 + ((ll[1] - subLon) * Math.sign(b.rotPeriod)) / 15; hr = ((hr % 24) + 24) % 24;
          const up = V.norm(V.sub(nav.S, b.wpos)), el = Math.asin(clamp(V.dot(up, V.norm(V.sub(sun.wpos, nav.S))), -1, 1)) * 180 / Math.PI;
          alt += `<div><b>Local solar time</b> ${String(Math.floor(hr)).padStart(2, '0')}:${String(Math.floor((hr % 1) * 60)).padStart(2, '0')} · sun ${el.toFixed(1)}°</div>`;
        }
      }
    }
    if (nav.dayLocked && nav._lock) alt += `<div class="dim">Time-lapse: time of day held at ${String(Math.floor(nav._lock.hour)).padStart(2, '0')}:${String(Math.floor((nav._lock.hour % 1) * 60)).padStart(2, '0')}${nav.yearLocked ? ', one frame per orbit' : ''}</div>`;
    if (nav.relativistic) { const b = nav.beta ? Math.hypot(...nav.beta) : 0; alt += `<div><b>Relativistic</b> v = ${b.toFixed(b > 0.99 ? 5 : 3)} c · γ = ${(nav.gamma || 1).toFixed(b > 0.99 ? 2 : 3)}</div>`; }
    if (nav.orbit) { const o = nav.orbit; alt += `<div><b>Orbit</b> ${fmtDist(Math.max(o.peri, 0))} × ${isFinite(o.apo) ? fmtDist(o.apo) : 'escape'} · ${isFinite(o.period) ? (o.period < 7200 ? (o.period / 60).toFixed(1) + ' min' : (o.period / 3600).toFixed(2) + ' h') : ''}</div>`; }
    // deep time: the Sun's state and the universe
    let deep = '';
    const tyr = nav.time / YEAR;
    if (Math.abs(tyr) > 3000 && tyr > -4.6e9 && tyr < 2.5e7) {
      // ice ages (shown when Earth is the selection or the place you are at)
      const e = solSystem().find('Earth'), sel = nav.selected && nav.selected.body;
      if (e && (sel === e || nav.anchor === e)) { const ice = e.iceAge || 0;
        const geo = geologicPeriod(tyr); if (geo) deep += `<div><b>${geo.name}</b> <span class="dim">${geo.life}</span></div>`;
        const cl = e.climate || {}, Tc = e.meanT ? Math.round(e.meanT - 273.15) + ' °C' : '';
        const what = cl.magma > 0 ? 'magma ocean' : cl.snowball ? 'Snowball Earth: ice to the equator' : Math.abs(tyr) < 3e6 && ice > 0.05 ? 'ice age: ' + Math.round(ice * 100) + '% of the last glacial maximum, sea level −' + Math.round(125 * Math.min(ice, 1.1)) + ' m' : Math.abs(tyr) < 3e6 ? 'interglacial' : e.meanT > 295 ? 'hothouse' : e.meanT < 287 ? 'cool, with polar ice' : 'temperate';
        deep += `<div><b>Climate</b> ${what}${Tc ? ' · global mean ' + Tc : ''} · Earth's orbit e = ${(e.orbitE || 0).toFixed(4)}</div>`;
        if (e.geomag && tyr > -4.2e9) { const g = e.geomag; deep += `<div><b>Magnetic field</b> ${g.reversing ? 'reversing: ' + Math.round(g.B * 100) + '% strength, aurora at low latitudes' : (g.normal ? 'normal' : 'reversed') + ' polarity'}${g.chron ? ' (' + g.chron + ')' : ''}</div>`; } }
    }
    if (Math.abs(tyr) > 1e5) {
      // (computed from the models directly: the Solar System is not updated while you are elsewhere)
      const ss = sunState(tyr), sunAge = ss.age;
      if (Math.abs(tyr) > 1e6) { const sol = solSystem(), e = sol.find('Earth'), eGone = engulfed('Earth', tyr), mGone = engulfed('Moon', tyr);
        if (e && !eGone) deep += `<div><b>Earth</b> day ${(earthDay(tyr) / 3600 * 1.0027).toFixed(2)} h${!mGone ? ' · Moon ' + Math.round(384400 * moonScale(tyr)).toLocaleString('en') + ' km' : ''}${e.climate && e.climate.dry > 0.05 ? ' · oceans ' + Math.round((1 - e.climate.dry) * 100) + '%' : ''}${e.paleoMyr > 0 ? ' · continents as ' + Math.min(Math.round(e.paleoMyr), 540) + ' Myr ago' + (e.paleoMyr > 541 ? ' (oldest map: 540 Myr)' : '') + ' (PALEOMAP)' : e.drift ? ' · continents drifted ' + Math.abs(e.drift).toFixed(e.drift < 10 ? 1 : 0) + ' Myr ' + (e.drift > 0 ? 'ahead' : 'back') + (tyr > 1e8 || tyr < -5e7 ? ' (held)' : '') : ''}</div>`; }
      if (sunAge < 0) deep += `<div><b>Sun</b> not yet formed: its gas is still part of a molecular cloud</div>`;
      else if (ss && Math.abs(tyr) > 2e7) deep += `<div><b>Sun</b> ${ss.phase} · ${ss.L < 10 ? ss.L.toFixed(2) : Math.round(ss.L).toLocaleString('en')} L☉ · ${ss.R < 10 ? ss.R.toFixed(2) : Math.round(ss.R)} R☉ · ${Math.round(ss.T).toLocaleString('en')} K${nav.level === 'galaxy' && tyr < 1e10 ? ' · ' + (Math.hypot(world.sunI[0], world.sunI[2]) / 1000).toFixed(1) + ' kpc from the centre' : ''}</div>`;
      const ageY = cosmo.tau * 1e9, ageS = ageY < 1 ? (ageY * 365.25 * 24).toFixed(1) + ' hours' : ageY < 1e4 ? Math.round(ageY).toLocaleString('en') + ' years' : ageY < 1e7 ? (ageY / 1e3).toFixed(ageY < 1e5 ? 1 : 0) + ' thousand years' : ageY < 1e9 ? (ageY / 1e6).toFixed(ageY < 1e8 ? 1 : 0) + ' million years' : cosmo.tau.toFixed(cosmo.tau < 100 ? 3 : 0) + ' Gyr';
      const era = ageY < 1 / 30 ? 'Big Bang nucleosynthesis: helium and deuterium nuclei are forming' : ageY < 5e4 ? 'Radiation era: an opaque plasma of nuclei, electrons and light' : ageY < 3.7e5 ? 'An opaque glowing plasma: light cannot travel far' : ageY < 1.2e6 ? 'Recombination: atoms form and the universe turns transparent; this light is the cosmic microwave background' : ageY < 1.5e8 ? (cosmo.T > 500 ? 'Dark ages: no stars yet; the background still glows dull red' : 'Dark ages: no stars yet') : ageY < 1e9 ? 'Cosmic dawn: the first stars and galaxies light up and reionize the gas' : ageY < 2e9 ? 'Young galaxies grow fast through mergers and streams of cold gas' : ageY < 4.5e9 ? 'Cosmic noon: galaxies are forming stars faster than at any other time, and quasars blaze in their cores' : '';
      deep += `<div class="dim">Universe ${ageS} old · background ${cosmo.T < 0.01 ? cosmo.T.toExponential(2) : cosmo.T < 1e4 ? cosmo.T.toFixed(cosmo.T < 100 ? 3 : 0) : cosmo.T.toExponential(2)} K${era ? '</div><div><b>Era</b> ' + era : ''}</div>`;
      if (LG.active && LG.behind) deep += '<div class="dim">Simulating the galaxy collision…</div>';
    }
    const watch = nav.paused ? '' : this.watchHint(nav);
    this.status.innerHTML = `<div><b>${loc}</b></div>${alt}${deep}${watch ? '<div class="dim"><b>At this rate</b> ' + watch + '</div>' : ''}<div><b>Speed</b> ${fmtSpeed(nav.speedNow)} <span class="dim">(set ${fmtSpeed(nav.speed)})</span></div><div class="dim">${Math.round(this.fps)} fps · EV ${(-Math.log2(r.exposure)).toFixed(1)}${r.stats.pending ? ' · loading ' + r.stats.pending : ''}</div>`;
    document.getElementById('tText').textContent = dstr + ' · ' + (nav.paused ? 'paused' : fmtRate(nav.rate));
    document.getElementById('tPause').textContent = nav.paused ? '▶' : '⏸';
    this.updateInfo(); this.updateLabels(); this.updateSys();
    if (rcfg.gpuTimes) {
      const t = r.gpuTimer;
      let html = `<b>${Math.round(this.fps)} fps</b> · ${r.w}×${r.h} (scale ${rcfg.scale.toFixed(2)})<br>`;
      if (t && t.ok) { let tot = 0; for (const [k, v] of Object.entries(t.results)) { if (k === 'end') continue; tot += v; html += `${k}: ${v.toFixed(2)} ms<br>`; } html += `<b>GPU total ${tot.toFixed(1)} ms</b>`; }
      else html += 'GPU timer queries are not available in this browser.';
      this.perf.innerHTML = html;
    }
  }
  updateInfo() {
    const nav = this.nav, t = nav.selected;
    if (!t) { this.info.classList.add('hidden'); this.lastInfoKey = null; return; }
    this.info.classList.remove('hidden');
    const dist = V.len(nav.relTo(t));
    // (rebuilt twice a second: the rows follow the simulation clock)
    const key = t.type + ':' + targetName(t) + ':' + Math.floor(performance.now() / 500);
    if (key !== this.lastInfoKey) {
      this.lastInfoKey = key;
      let rows = [], sub = '';
      if (t.type === 'body' && t.body.gone) { rows = [['Status', t.body.unborn || (t.body.system && t.body.system.unborn) || (t.body.system && t.body.system.desc && t.body.system.desc.sol && nav.time / YEAR < -4.5e9) ? 'not yet formed at this time' : 'no longer exists at this time']]; sub = t.body.kind[0].toUpperCase() + t.body.kind.slice(1); }
      else if (t.type === 'body') { rows = describeBody(t.body); sub = t.body.kind === 'star' ? 'Star' : t.body.kind[0].toUpperCase() + t.body.kind.slice(1); if (t.body.parent && t.body.parent.kind !== 'barycenter') sub += ' of ' + t.body.parent.name; }
      else if (t.type === 'star') { const s = t.desc.star; sub = 'Star'; rows = [['Class', s.cls], ['Temperature', Math.round(s.T) + ' K'], ['Mass', (s.mass / C.Msun).toPrecision(3) + ' M<sub>Sun</sub>'], ['Radius', (s.radius / C.Rsun).toPrecision(3) + ' R<sub>Sun</sub>'], ['Luminosity', s.lum.toPrecision(3) + ' L<sub>Sun</sub>'], ['Abs. magnitude', s.MV.toFixed(2)]]; }
      else if (t.type === 'nebula') {
        // (catalogued nebulae: their state at the current time)
        const base = t.neb.base || t.neb, real = base.gen === undefined && base.age !== undefined && !base.proc;
        const nb = real ? (nebulaAt(base) || base) : t.neb, ageNow = real ? base.age + world.tyr : nb.age;
        sub = nb.cluster ? 'Globular cluster' : ['Emission nebula (H II region)', 'Planetary nebula', 'Supernova remnant', 'Protoplanetary disk'][nb.type] || 'Nebula';
        rows = real && ageNow < 0 ? [['Status', 'the star has not exploded yet (in ' + fmtSpan(-ageNow) + ')']] : [['Diameter', (nb.radius * 2 * 3.2616).toPrecision(3) + ' ly']];
        if (real && ageNow >= 0) rows.push(['Age', fmtSpan(ageNow)]);
        else if (nb.age !== undefined && nb.life && !real) rows.push(['Age', fmtSpan(nb.age) + ' (lasts ~' + (nb.life < 1e6 ? Math.round(nb.life / 1e3) + ',000 years' : Math.round(nb.life / 1e6) + ' million years') + ')']);
        if (nb.type === 0 && !nb.cluster) rows.push(['Lit by', 'young O and B stars, ionizing hydrogen (red H-alpha) and oxygen (teal [O III])']);
        else if (nb.type === 1) rows.push(['Lit by', 'the hot exposed core of a dying Sun-like star, now becoming a white dwarf']);
        else if (nb.type === 2) rows.push(['Shock', 'a supernova blast wave sweeping up interstellar gas (Sedov expansion, radius ~ t^0.4)']);
      }
      else {
        const g = t.galaxy; sub = 'Galaxy'; rows = [['Type', g.subtype], ['Diameter', (g.radius * 2 * 3.2616 / 1000).toPrecision(3) + ' kly'], ['Stellar mass', g.mass.toExponential(1) + ' M<sub>Sun</sub>'], ['Stars', '~' + g.nstars.toExponential(1)]];
        // (seen from the Milky Way at the current time, through the expanding universe)
        const gi = g !== MILKY_WAY && galaxyInfo(V.len(g.posU));
        if (gi) {
          rows.push(['Redshift', 'z = ' + gi.z.toFixed(gi.z < 0.1 ? 4 : 2)]);
          rows.push(['Light left it', fmtSpan(gi.lookback * 1e9) + ' ago']);
          rows.push(['Receding at', gi.v < 3e5 ? Math.round(gi.v).toLocaleString('en') + ' km/s' : (gi.v / 299792).toFixed(1) + ' c (space itself expanding)']);
        }
      }
      const html = `<h2>${targetName(t)}</h2><div class="sub">${sub}</div><table>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}<tr><td>Distance</td><td id="iDist"></td></tr>${t.type === 'star' ? '<tr><td>App. magnitude</td><td id="iMag"></td></tr>' : ''}${t.type === 'body' && !t.body.gone && t.body.kind !== 'star' && t.body.kind !== 'barycenter' ? '<tr><td>Illuminated</td><td id="iIll"></td></tr>' : ''}</table>`;
      if (html !== this._infoHtml) { this.info.innerHTML = html; this._infoHtml = html; }
    }
    const d = document.getElementById('iDist'); if (d) d.textContent = fmtDist(dist);
    const m = document.getElementById('iMag'); if (m) m.textContent = (t.desc.star.MV + 5 * Math.log10(dist / C.PC) - 5).toFixed(2);
    const il = document.getElementById('iIll');
    if (il && t.type === 'body') {
      // fraction of the disc that is sunlit as seen from here, with the usual phase names for moons
      const b = t.body, sun = b.system.stars[0];
      if (sun && b.wpos) {
        const toS = V.norm(V.sub(sun.wpos, b.wpos)), toC = V.norm(V.mul(nav.relTo(t), -1));
        const k = (1 + V.dot(toS, toC)) / 2;
        let name = '';
        if (b.kind === 'moon' && nav.anchor && nav.anchor === b.parent) {
          const waxing = V.dot(V.cross(toC, toS), Q.rot(b.parent.wrot, [0, 1, 0])) > 0;
          name = k > 0.97 ? 'full' : k < 0.03 ? 'new' : k > 0.5 ? (waxing ? 'waxing gibbous' : 'waning gibbous') : (waxing ? 'waxing crescent' : 'waning crescent');
          if (Math.abs(k - 0.5) < 0.03) name = waxing ? 'first quarter' : 'last quarter';
        }
        il.textContent = (k * 100).toFixed(k > 0.995 || k < 0.005 ? 1 : 0) + '%' + (name ? ' · ' + name : '');
      }
    }
  }
  label(i) { while (this.labelPool.length <= i) this.labelPool.push(this.labels.appendChild(el('div', 'label'))); return this.labelPool[i]; }
  updateLabels() {
    const nav = this.nav, r = this.r, rect = this.canvas.getBoundingClientRect();
    let n = 0;
    const put = (rel, text, cls, offPx) => {
      const p = r.project(rel); if (!p || p[0] < -0.05 || p[0] > 1.05 || p[1] < -0.05 || p[1] > 1.05) return;
      const l = this.label(n++); l.textContent = text; l.className = 'label ' + cls; l.style.display = 'block';
      l.style.transform = `translate(${(p[0] * rect.width + (offPx || 6)).toFixed(1)}px, ${(p[1] * rect.height - 8).toFixed(1)}px)`;
    };
    const groundUp = nav.anchor && nav.altitude < nav.anchor.radius * 0.05 ? V.norm(V.sub(nav.S, nav.anchor.wpos)) : null;
    if (this.showLabels) {
      if (nav.system && nav.level === 'system') {
        for (const b of nav.system.bodies) {
          if (b.kind === 'barycenter' || !b.rel) continue;
          // standing on a body: no labels for things below the horizon
          if (groundUp && b !== nav.anchor && V.dot(b.rel, groundUp) / (b.dist || 1) < -0.01) continue;
          const px = b.pxRadius || 0;
          if (px > 60) continue;
          if (b.orbit && (b.kind === 'moon' || (b.parent && b.parent.kind === 'planet'))) { const pd = b.parent.dist || 1e30; if (b.orbit.a / pd * r.pxPerRad < 25) continue; }
          if ((b.kind === 'dwarf' || b.kind === 'comet') && b.dist > b.radius * 2e4 && !(nav.selected && nav.selected.body === b)) continue;
          if (b.kind === 'planet' && b.orbit && b.orbit.a / Math.max(b.parent.dist || 1, 1) * r.pxPerRad < 9) continue;
          put(b.rel, b.name, b.kind, Math.max(6, px + 4));
        }
      }
      if (nav.level !== 'system' || (nav.system && V.len(nav.S) > 3e13)) {
        const cu = nav.camU();
        const selG = nav.selected && nav.selected.galaxy, merged = LG_ORBIT.merged > 0 && world.tyr > 27 + LG_ORBIT.merged * 1e6, lmcGone = lgWeights(world.tyr).lmc < 0.5;
        for (const g of REAL_GALAXIES) { const gv = galaxyView(V.len(g.posU)); if (gv.f < 1e-3 || g === selG) continue; const rel = V.sub(apparentPosU(g), cu), d = V.len(rel); if (d < g.radius * 1.5e-6) continue; if (merged && g === M31 || lmcGone && /Magellanic/.test(g.name)) continue;
          if (g.radius * 1e-6 / d * r.pxPerRad > 3) put(rel, (merged && g === MILKY_WAY ? 'Milkomeda (Milky Way + Andromeda)' : g.name) + (gv.z > 0.05 && Math.abs(nav.time) > 3e16 ? ' (z = ' + gv.z.toFixed(gv.z < 1 ? 2 : 1) + ')' : ''), 'galaxy', 10); }
      }
      // star, constellation and nebula labels only when the sky is dark enough to show them
      const darkSky = r.exposure > 2000;
      if (darkSky && nav.galaxy === MILKY_WAY && nav.level !== 'universe' && catalog.ready) {
        const cam = nav.camLocal(), gq = nav.galaxy.quat, d = catalog.data, cc = nav.field && nav.field.cells.get('catalog'), q3 = [0, 0, 0];
        const ds = V.dist(cam, world.sunP);
        if (ds < 300 && cc && world.catW > 0.5) {
          nav.field.cellPhase(cc);
          const rel = (i) => { nav.field.posOf(cc, i, q3); return Q.rot(gq, [q3[0] - cam[0], q3[1] - cam[1], q3[2] - cam[2]]); };
          if (rcfg.constellations) for (const c of catalog.constellations) {
            if (!c.lines.length) continue;
            let sx = 0, sy = 0, sz = 0, k = 0;
            for (const [a] of c.lines) { const r = V.norm(rel(a)); sx += r[0]; sy += r[1]; sz += r[2]; k++; }
            put([sx / k, sy / k, sz / k], c.name, 'const', 0);
          }
          // brightest named stars as seen from here
          let nlab = 0;
          for (const n of catalog.named) {
            if (nlab > 25) break;
            const r = rel(n.i), dist = V.len(r), m = d[n.i * 5 + 3] + 5 * Math.log10(Math.max(dist, 1e-6)) - 5;
            if (m < 1.6 && !/^(HIP|HYG) /.test(n.name) && !(nav.field.deadCat && nav.field.deadCat.has(n.i))) { put(r, n.name, 'star', 7); nlab++; }
          }
        }
      }
      if (darkSky && nav.level !== 'universe' && nav.galaxy) {
        for (const v of visibleNebulae) if (v.px > 6 && v.px < 500 && v.nb.name && !(nav.selected && nav.selected.neb === v.nb)) put(v.rel, v.nb.name, 'galaxy', Math.min(v.px, 60) + 6);
      }
    }
    // selection marker
    const t = nav.selected; let shown = false;
    if (t && !(t.type === 'body' && t.body.gone)) {
      const rel = nav.relTo(t), p = r.project(rel);
      if (p && p[0] > -0.1 && p[0] < 1.1 && p[1] > -0.1 && p[1] < 1.1) {
        const d = V.len(rel), ang = nav.targetRadius(t) / d * r.pxPerRad / rcfg.scale;
        if (ang < 40) {
          const sz = Math.max(18, ang * 2 + 14); shown = true;
          this.marker.style.display = 'block'; this.marker.style.width = this.marker.style.height = sz + 'px';
          this.marker.style.transform = `translate(${(p[0] * rect.width - sz / 2).toFixed(1)}px, ${(p[1] * rect.height - sz / 2).toFixed(1)}px)`;
          if (this.showLabels && (t.type !== 'body' || (t.body.pxRadius || 0) <= 60) && !(t.type === 'body' && nav.level === 'system' && t.body.system === nav.system)) put(rel, targetName(t), 'sel', sz / 2 + 4);
        }
      }
    }
    if (!shown) this.marker.style.display = 'none';
    for (let i = n; i < this.labelPool.length; i++) this.labelPool[i].style.display = 'none';
  }
  updateTimeline() {
    if (this.linePanel.classList.contains('hidden')) return;
    if (document.activeElement && document.activeElement.id === 'tlYears') return;
    if (this.sliding) return;
    const tyr = this.nav.time / YEAR, tl = this.timeline, nx = tl.next(tyr);
    const key = (nx ? nx.id : '') + ':' + Math.floor(Date.now() / 500);
    if (key === this.lineKey) return; this.lineKey = key;
    const rows = tl.events.map((e, i) => {
      const dt = e.t - tyr, past = dt < 0;
      return `<div class="row${past ? ' past' : ''}${e === nx ? ' sel' : ''}" data-i="${i}" title="${e.text.replace(/"/g, '&quot;')}"><span class="nm">${e.title}${e.est ? ' <span class="dim">(estimate)</span>' : ''}</span><span class="ds">${past ? fmtSpan(dt) + ' ago' : 'in ' + fmtSpan(dt)}</span><button data-i="${i}">Go</button></div>`;
    }).join('');
    this.linePanel.innerHTML = `<h3>Timeline</h3>
      <div class="tlslider"><input type="range" id="tlSlide" min="-100" max="140" step="0.1" value="${this.sliderPos(tyr)}"><div class="tlticks">${[[-100, 'Big Bang'], [-60, '−1 Myr'], [0, 'now'], [60, '+1 Myr'], [90, '+1 Gyr'], [140, '+10¹⁴ yr']].map(([x, l]) => `<span style="left:${((x + 100) / 240 * 100).toFixed(1)}%">${l}</span>`).join('')}</div></div>
      <div class="tljump">Jump to <input id="tlYears" placeholder="e.g. 2 Gyr, -65 Myr, year 3000, age 380 kyr" value="${this.tlYears || ''}"> <button id="tlGo">Go</button></div>
      <div class="list">${rows}</div><label class="dim"><input type="checkbox" id="tlAuto" ${tl.auto ? 'checked' : ''}> Slow down for events</label>
      <p class="dim">Go jumps to just before the event. Times are from the simulation's own models; "estimate" marks dates that are uncertain.</p>`;
    this.linePanel.querySelectorAll('button').forEach(b => { b.onclick = () => { tl.go(tl.events[+b.dataset.i]); this.lineKey = null; }; });
    this.linePanel.querySelector('#tlAuto').onchange = (e) => { tl.auto = e.target.checked; };
    const sl = this.linePanel.querySelector('#tlSlide');
    sl.oninput = () => { this.nav.time = (Date.now() - Date.UTC(2000, 0, 1, 12)) / 1000 + this.sliderYears(+sl.value) * YEAR; this.timeline.lastTyr = this.nav.time / YEAR; this.sliding = true; };
    sl.onchange = () => { this.sliding = false; this.lineKey = null; };
    const yi = this.linePanel.querySelector('#tlYears');
    yi.oninput = () => { this.tlYears = yi.value; };
    yi.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') this.linePanel.querySelector('#tlGo').click(); };
    this.linePanel.querySelector('#tlGo').onclick = () => {
      const y = parseTimeSpec(yi.value); if (y === null) { this.toast('Try 5e9, 2 Gyr, -65 Myr, 65 million years ago, year 3000 or age 380 kyr'); return; }
      this.nav.time = (Date.now() - Date.UTC(2000, 0, 1, 12)) / 1000 + y * YEAR; this.timeline.lastTyr = this.nav.time / YEAR; this.lineKey = null;
      this.toast(fmtSimDate(this.nav.time));
    };
  }
  // logarithmic time slider: 0 = now; positive x -> 10^(x/10) years ahead (x = 140 is 10^14), negative -> back to the Big Bang
  sliderYears(x) { if (Math.abs(x) < 0.5) return 0; const y = Math.pow(10, Math.abs(x) / 10); return x > 0 ? Math.min(y, 1e14) : -Math.min(y, 13.78e9); }
  sliderPos(tyr) { const dy = tyr - (Date.now() - Date.UTC(2000, 0, 1, 12)) / 1000 / YEAR; if (Math.abs(dy) < 1) return 0; return Math.sign(dy) * Math.min(140, 10 * Math.log10(Math.abs(dy))); }
  // set up the camera for an event from the timeline
  eventView(e) {
    const nav = this.nav, v = e.view || {}, sol = solSystem();
    // after a jump, bring the galaxy collision simulation (and with it the Sun's galactic position) up to date first
    { const tMyr = (nav.time / YEAR - 26.8) / 1e6; if (tMyr > LG_START) LG.advance(tMyr, 100000); updateWorld(nav.time); updateLocalGroupPositions(nav.time / YEAR); }
    nav.goto = null; nav.onArrive = null; nav.lookTarget = null; nav.orbit = null; nav.fov = 55 * Math.PI / 180;
    // events happen in the real universe: leave the sandbox (whose bodies may share names with real ones)
    if (nav.system && nav.system.sandbox) { nav.system = sol; nav.level = 'system'; nav.useGalaxy(sol.galaxy); nav.anchor = null; nav.selected = null; if (this.sbui) this.sbui.panel.classList.add('hidden'); }
    // (bring the Solar System to the new date before looking anything up: which bodies exist depends on it)
    sol.update(nav.time);
    this.caption(e.title, e.text + (e.est ? ' <span class="dim">Date is an estimate.</span>' : ''), '', '');
    clearTimeout(this.capTimer); this.capTimer = setTimeout(() => { if (!this.tour.active) this.caption(null); }, 14000);
    if (v.star) {
      const t = findByName(nav, v.star); if (!t) return;
      sol.update(nav.time);
      const earth = sol.find('Earth'), sun = sol.find('Sun');
      if (v.from === 'earth') {
        // stand on the night side of Earth with the star about 35 degrees up
        const upFor = () => {
          const s = V.norm(nav.relGalactic ? nav.relTo(t) : [0, 0, -1]);
          const toSun = V.norm(V.sub(sun.wpos, earth.wpos));
          let perp = V.sub(V.mul(toSun, -1), V.mul(s, V.dot(V.mul(toSun, -1), s))); if (V.len(perp) < 1e-3) perp = V.cross(s, [0, 1, 0]);
          perp = V.norm(perp);
          return V.norm(V.add(V.mul(s, Math.cos(55 * Math.PI / 180)), V.mul(perp, Math.sin(55 * Math.PI / 180))));
        };
        // a supernova stays near its peak for months: wait (up to three weeks) for a night without the Moon
        const moon = sol.find('Moon'), t0 = nav.time;
        if (e.hold && moon) for (let d = 0; d < 22; d++) {
          nav.time = t0 + d * 86400; sol.update(nav.time);
          if (V.dot(V.norm(V.sub(moon.wpos, earth.wpos)), upFor()) < -0.15) break;
          if (d === 21) { nav.time = t0; sol.update(nav.time); }
        }
        const up = upFor();
        nav.land(earth, { dir: up });
        nav.onArrive = () => { nav.lookTarget = t; };
        nav.selected = t;
      } else {
        // deep space just outside the Solar System, looking at the star
        nav.system = sol; nav.level = 'system'; nav.useGalaxy(sol.galaxy); nav.anchor = null;
        nav.S = [0, C.AU * 80, 0]; nav.selected = t; nav.q = Q.look(nav.relTo(t), [0, 1, 0]);
      }
      return;
    }
    if (v.globe) {
      // a whole-Earth view from ~20,000 km over a given place at early afternoon
      const t = findByName(nav, v.globe); if (!t || t.type !== 'body') return;
      const b = t.body; nav.system = sol; nav.level = 'system'; nav.useGalaxy(sol.galaxy); nav.anchor = null;
      // move to midsummer in that hemisphere (within the year) so the place is in full sunlight
      if (v.at !== undefined) { nav.time = v.at * YEAR - 900; sol.update(nav.time); }      // (an exact moment: no season or hour adjustments)
      else if (b.seasonal) { const t0 = nav.time; let best = t0, bs = -9; for (let f = 0; f < 1; f += 0.02) { nav.time = t0 + f * YEAR; sol.update(nav.time); const sv = (b.season || 0) * Math.sign(v.lat || 1); if (sv > bs) { bs = sv; best = nav.time; } } nav.time = best; }
      sol.update(nav.time); if (v.at === undefined) nav.setLocalTime(b, v.lon, 13);
      const la = v.lat * Math.PI / 180, lo = v.lon * Math.PI / 180, d = Q.rot(b.wrot, [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)]);
      nav.S = V.add(b.wpos, V.mul(d, b.radius * 3.4)); nav.q = Q.look(V.mul(d, -1), Q.rot(b.wrot, [0, 1, 0])); nav.selected = t; nav.anchor = b;
      return;
    }
    if (v.body) {
      const t = findByName(nav, v.body); if (!t) return;
      nav.selected = t;
      if (v.far && t.type === 'body') {
        // from outside the planet's orbit and above the ecliptic, looking back past it at the (giant) Sun
        const b = t.body, sun = sol.find('Sun'); sol.update(nav.time);
        nav.system = sol; nav.level = 'system'; nav.useGalaxy(sol.galaxy); nav.anchor = null;
        const out = V.norm(V.sub(b.wpos, sun.wpos)), dir = V.norm(V.add(out, [0, 0.45, 0]));
        nav.S = V.add(b.wpos, V.mul(dir, Math.max(C.AU * 1.2, V.dist(b.wpos, sun.wpos) * 0.9)));
        nav.q = Q.look(V.sub(V.mul(V.add(b.wpos, sun.wpos), 0.5), nav.S), [0, 1, 0]); nav.fov = 70 * Math.PI / 180;
      } else nav.goTo(t, {});
      return;
    }
    if (v.land) { const t = findByName(nav, v.land); if (t && t.type === 'body') { nav.landAt(t.body, 10, -60, { hour: v.hour || 12 }); nav.onArrive = () => { nav.lookTarget = { type: 'body', body: sol.find('Sun') }; nav.fov = 80 * Math.PI / 180; }; } return; }
    if (v.pn) {
      // from about a parsec away, looking back at the Sun (later than the jump point so the shell is lit). After the
      // Andromeda encounter the Sun's position comes from the N-body tracer, so fly there rather than placing the camera
      nav.time += 1.6e4 * YEAR; updateWorld(nav.time);
      const t = { type: 'star', desc: sol.desc };
      nav.selected = t; nav.goTo(t, { dist: 0.9 * C.PC, dur: 3 });
      return;
    }
    if (v.lg) {
      const t = findByName(nav, 'Andromeda');
      if (v.lg === 'outside') {
        // above the orbital plane of the pair, looking at the collision
        const n = V.norm(V.cross(LG_R0, LG_V0));
        nav.level = 'universe'; nav.useGalaxy(null); nav.system = null; nav.anchor = null;
        const mid = t ? V.mul(t.galaxy.posU, 0.5) : [0, 0, 0];
        nav.U = V.add(mid, V.mul(n, v.d || 0.16)); nav.q = Q.look(V.sub(mid, nav.U), [0, 1, 0]);
        if (t) nav.selected = t;
      } else {
        // from the Solar System, looking at Andromeda
        const sol = solSystem(); sol.update(nav.time);
        nav.system = sol; nav.level = 'system'; nav.useGalaxy(sol.galaxy); nav.anchor = null;
        nav.S = [0, C.AU * 80, 0];
        if (t) { nav.selected = t; nav.q = Q.look(nav.relTo(t), [0, 1, 0]); }
        nav.fov = 80 * Math.PI / 180;
      }
      return;
    }
    if (v.galaxy) {
      // above (or beside) the Milky Way, with the Sun selected and its galactic orbit drawn
      const mw = findByName(nav, 'Milky Way').galaxy, sunT = { type: 'star', desc: sol.desc };
      nav.useGalaxy(mw); nav.system = null; nav.anchor = null; nav.level = 'galaxy';
      const sp = Q.rot(mw.quat, world.sunP);
      if (v.galaxy === 'top') { nav.G = Q.rot(mw.quat, [0, 42000, 0]); nav.q = Q.look(V.mul(nav.G, -1), Q.rot(mw.quat, [1, 0, 0])); }
      else { const out = V.norm([sp[0], 0, sp[2]]); nav.G = V.add(sp, V.add(V.mul(V.cross(out, [0, 1, 0]), 3500), [0, 600, 0])); nav.q = Q.look(V.sub(sp, nav.G), [0, 1, 0]); }
      nav.selected = sunT;
      return;
    }
    if (v.pole) {
      const earth = sol.find('Earth'); sol.update(nav.time);
      nav.landAt(earth, 52, -112, { hour: 0 });   // a dark site on the Canadian prairie
      nav.onArrive = () => { nav.lookTarget = { type: 'dir', dir: Q.rot(earth.wrot, [0, 1, 0]) }; };
      return;
    }
    if (v.universe) { const t = findByName(nav, 'Milky Way'); if (t) { nav.selected = t; nav.goTo(t, { dist: 3e6 * C.PC }); } }
    if (v.ppd) {
      // a few hundred AU from the newborn Sun, looking down onto its disk
      nav.system = sol; nav.level = 'system'; nav.useGalaxy(sol.galaxy); nav.anchor = null; sol.update(nav.time);
      nav.S = [C.AU * 260, C.AU * 120, C.AU * 40]; nav.q = Q.look(V.mul(nav.S, -1), [0, 1, 0]); nav.fov = 60 * Math.PI / 180;
      nav.selected = { type: 'star', desc: sol.desc };
    }
    if (v.cosmos) {
      // out among the galaxies (in the early universe there is nothing else to look at)
      nav.level = 'universe'; nav.useGalaxy(null); nav.system = null; nav.anchor = null; nav.selected = null;
      nav.U = [3, 2, 4]; nav.q = Q.look([1, 0.1, -0.3], [0, 1, 0]); nav.fov = 70 * Math.PI / 180;
    }
    if (v.sandbox) { const u = this.sbui; const i = u.presets.findIndex(p => p.id === v.sandbox); if (i >= 0) { u.start(i); u.panel.classList.remove('hidden'); } }
  }
  updateSys() {
    if (this.sysPanel.classList.contains('hidden')) return;
    const nav = this.nav, sys = nav.system || null;
    const key = (sys ? sys.name : 'none') + ':' + (nav.selected ? targetName(nav.selected) : '');
    if (key === this.sysKey) return; this.sysKey = key;
    if (!sys) { this.sysPanel.innerHTML = '<h3>No star system nearby</h3><p class="dim">Select a star and press G to visit it.</p>'; return; }
    const rows = sys.bodies.filter(b => b.kind !== 'barycenter').map(b => {
      const sel = nav.selected && nav.selected.body === b ? ' sel' : '';
      const d = b.orbit ? (b.orbit.a > 0.01 * C.AU ? (b.orbit.a / C.AU).toPrecision(3) + ' AU' : Math.round(b.orbit.a / 1e3).toLocaleString('en') + ' km') : '';
      return `<div class="row${sel} d${b.depth}" data-uid="${b.uid}"><span class="dot ${b.kind}"></span><span class="nm">${b.name}</span><span class="cl">${b.cls}</span><span class="ds">${d}</span></div>`;
    }).join('');
    this.sysPanel.innerHTML = `<h3>${sys.name}</h3><div class="list">${rows}</div><p class="dim">Click to select, double click to go.</p>`;
    this.sysPanel.querySelectorAll('.row').forEach(row => {
      const b = sys.bodies.find(x => x.uid === +row.dataset.uid);
      row.onclick = () => { nav.selected = { type: 'body', body: b }; };
      row.ondblclick = () => { nav.goTo({ type: 'body', body: b }); };
    });
  }
}

// "5e9", "2 Gyr", "-65 Myr", "65 million years ago", "in 3 billion years", "year 3000", "500 BC", "age 380 kyr",
// "1 Gyr after the Big Bang" -> years from now (null if not understood)
export function parseTimeSpec(str) {
  let t = String(str).trim().toLowerCase().replace(/,/g, '').replace(/\u2212/g, '-'); if (!t) return null;
  const nowY = (Date.now() - Date.UTC(2000, 0, 1, 12)) / 1000 / YEAR;
  const unit = { yr: 1, y: 1, year: 1, years: 1, kyr: 1e3, thousand: 1e3, myr: 1e6, million: 1e6, gyr: 1e9, billion: 1e9, tyr: 1e12, trillion: 1e12, ka: 1e3, ma: 1e6, ga: 1e9 };
  const amount = (s) => { const m = s.match(/^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*([a-z]*)/); if (!m) return null; let v = parseFloat(m[1]); const u = m[2]; if (u && unit[u] === undefined) return null; return v * (u ? unit[u] : 1); };
  let m;
  if ((m = t.match(/^year\s+(-?\d+)\s*(bc|bce|ad|ce)?$/)) || (m = t.match(/^(-?\d+)\s*(bc|bce|ad|ce)$/))) {
    let y = parseFloat(m[1]); if (m[2] === 'bc' || m[2] === 'bce') y = 1 - y;
    return y - 2000 - nowY;
  }
  if ((m = t.match(/^(?:age|cosmic age)\s+(.*)$/)) || (m = t.match(/^(.*?)\s+after (?:the )?big bang$/))) {
    const a = amount(m[1].replace(/\s*years?$/, '')); if (a === null) return null;
    return -13.79e9 + a - nowY;
  }
  let sign = 1;
  if ((m = t.match(/^(.*?)\s+ago$/))) { t = m[1]; sign = -1; }
  if ((m = t.match(/^in\s+(.*)$/))) t = m[1];
  t = t.replace(/\s*years?$/, '').replace(/^(\S+)\s+(thousand|million|billion|trillion)$/, '$1 $2');
  const a = amount(t); if (a === null || !isFinite(a)) return null;
  return sign * a;
}
