// HUD, input handling, object info, search, time controls and labels.
import { V, Q, C, clamp } from './math.js';
import { targetName, findByName, searchList, solSystem } from './nav.js';
import { describeBody } from './system.js';
import { starName } from './system.js';
import { galaxyName, REAL_GALAXIES } from './universe.js';
import { rcfg } from './render.js';
import { RNG } from './rng.js';
import { visibleNebulae } from './exotic.js';
import { catalog, loadCatalog } from './assets.js';
import { SUN_POS, MILKY_WAY } from './universe.js';

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
function fmtRate(r) {
  const a = Math.abs(r), s = r < 0 ? '−' : '';
  if (a === 1) return s + 'real time';
  if (a < 60) return s + a + '×';
  if (a < 3600) return s + (a / 60).toPrecision(3) + ' min/s';
  if (a < 86400) return s + (a / 3600).toPrecision(3) + ' h/s';
  if (a < 31557600) return s + (a / 86400).toPrecision(3) + ' d/s';
  return s + (a / 31557600).toPrecision(3) + ' yr/s';
}
const RATES = [1, 10, 60, 600, 3600, 6 * 3600, 86400, 7 * 86400, 30 * 86400, 31557600 / 4, 31557600, 31557600 * 10, 31557600 * 100, 31557600 * 1e3, 31557600 * 1e5, 31557600 * 1e7];

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
    this.top.innerHTML = `<input id="search" placeholder="Search: Saturn, Titan, Andromeda…" autocomplete="off" list="searchlist"><datalist id="searchlist"></datalist>
      <select id="places" title="Places"><option value="">Places…</option></select>
      <button id="bGo" title="Go to selection (G)">Go to</button><button id="bLand" title="Land on selection (L)">Land</button><button id="bSys" title="System browser (Tab)">System</button><button id="bRand" title="Travel somewhere new">Explore</button><button id="bSet" title="Settings">⚙</button><button id="bHelp" title="Help (H)">?</button>`;
    this.status = root.appendChild(el('div', 'panel status'));
    this.timebar = root.appendChild(el('div', 'panel time'));
    this.timebar.innerHTML = `<button id="tRev" title="Reverse (J)">⏪</button><button id="tSlow" title="Slower (,)">−</button><button id="tPause" title="Pause (Space)">⏸</button><button id="tFast" title="Faster (.)">+</button><button id="tReal" title="Real time (\\)">1×</button><button id="tNow" title="Current date">Now</button><button id="tDate" title="Set date and time">Date</button><button id="bShare" title="Copy a link to this place and time">Link</button><span id="tText"></span>
      <input id="tDateIn" type="datetime-local" step="60" class="hidden">`;
    this.labels = root.appendChild(el('div', 'labels'));
    this.perf = root.appendChild(el('div', 'panel perf hidden'));
    this.marker = root.appendChild(el('div', 'marker'));
    this.sysPanel = root.appendChild(el('div', 'panel sys hidden'));
    this.setPanel = root.appendChild(el('div', 'panel settings hidden'));
    this.help = root.appendChild(el('div', 'panel help hidden'));
    this.help.innerHTML = `<h2>Cosmos</h2><p>A procedural universe at 1:1 scale. Everything you see can be visited.</p>
      <table>
      <tr><td>Left drag</td><td>Look around</td></tr><tr><td>Right drag</td><td>Orbit the selected object</td></tr>
      <tr><td>Wheel</td><td>Change flight speed (Ctrl + wheel: zoom to selection)</td></tr>
      <tr><td>W A S D, R F</td><td>Fly (Shift faster, Ctrl slower)</td></tr><tr><td>Q E, arrows</td><td>Roll, turn</td></tr>
      <tr><td>Click / double click</td><td>Select / go to object</td></tr><tr><td>G, L, C</td><td>Go to, land on, look at selection</td></tr>
      <tr><td>Space , . J \\</td><td>Pause, slower, faster, reverse, real time</td></tr>
      <tr><td>0 – 9</td><td>Sun, Mercury … Pluto</td></tr><tr><td>Tab</td><td>System browser</td></tr><tr><td>O, N, K</td><td>Toggle orbits, labels, constellations</td></tr>
      <tr><td>[ ]</td><td>Exposure down / up</td></tr><tr><td>Z X</td><td>Zoom field of view</td></tr><tr><td>F2, F3</td><td>Hide interface, GPU timings</td></tr><tr><td>P</td><td>Save screenshot</td></tr>
      </table><p class="dim">Press H or ? to close.</p>`;
    this.hint = root.appendChild(el('div', 'hint', 'Drag to look · W A S D to fly · double click an object to travel · <b>H</b> for help'));
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
    const fillSearch = () => { document.getElementById('searchlist').innerHTML = searchList(nav).map(n => `<option value="${n}">`).join(''); };
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
      <label><input type="checkbox" id="sFlare" ${rcfg.flare ? 'checked' : ''}> Lens flare</label>
      <label><input type="checkbox" id="sAutoScale" ${rcfg.autoScale ? 'checked' : ''}> Dynamic resolution</label>
      <label>Quality <select id="sQual"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select> <span class="dim">(reloads)</span></label>`;
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
    q('sAutoScale').onchange = (e) => { rcfg.autoScale = e.target.checked; };
    q('sQual').value = rcfg.quality || 'high';
    s.addEventListener('input', () => this.saveSettings()); s.addEventListener('change', () => this.saveSettings());
    q('sQual').onchange = (e) => { const u = new URL(location.href); u.searchParams.set('q', e.target.value); location.href = u.toString(); };
  }
  bind() {
    const c = this.canvas, nav = this.nav;
    let down = null, moved = 0;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => { c.setPointerCapture(e.pointerId); down = { b: e.button, x: e.clientX, y: e.clientY }; moved = 0; document.activeElement && document.activeElement.blur(); });
    c.addEventListener('pointermove', e => {
      if (!down) return;
      const dx = e.movementX, dy = e.movementY; moved += Math.abs(dx) + Math.abs(dy);
      if (down.b === 2 || e.altKey) { this.acc.orbitX += dx; this.acc.orbitY += dy; } else { this.acc.lookX -= dx; this.acc.lookY -= dy; }
    });
    c.addEventListener('pointerup', e => {
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
      else if (k >= '0' && k <= '9' && !e.ctrlKey && !e.altKey) this.search(['Sun', 'Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'][+k]);
      else if (k === 'l') { if (nav.selected && nav.selected.type === 'body') nav.land(nav.selected.body); }
      else if (k === ' ') { e.preventDefault(); nav.paused = !nav.paused; }
      else if (k === '.') this.stepRate(1); else if (k === ',') this.stepRate(-1);
      else if (k === 'j') nav.rate = -nav.rate; else if (k === '\\') { nav.rate = 1; nav.paused = false; }
      else if (k === 'h' || k === '?') this.toggle(this.help);
      else if (k === 'k') rcfg.constellations = !rcfg.constellations;
      else if (k === 'o') rcfg.orbits = !rcfg.orbits; else if (k === 'n') this.showLabels = !this.showLabels;
      else if (k === '[') rcfg.exposureBias -= 0.5; else if (k === ']') rcfg.exposureBias += 0.5;
      else if (k === 'escape') { nav.goto = null; [this.sysPanel, this.setPanel, this.help].forEach(p => p.classList.add('hidden')); }
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
    $('bSet').onclick = () => this.toggle(this.setPanel);
    $('bHelp').onclick = () => this.toggle(this.help);
    $('bRand').onclick = () => this.explore();
    $('search').addEventListener('change', e => { this.search(e.target.value); });
    const groups = { 'Solar System': ['Sun', 'Mercury', 'Venus', 'Earth', 'Moon', 'Mars', 'Jupiter', 'Io', 'Europa', 'Saturn', 'Titan', 'Enceladus', 'Uranus', 'Neptune', 'Triton', 'Pluto', "Halley's Comet"],
      'Exoplanets': ['Proxima Centauri', 'TRAPPIST-1', 'Helvetios', 'Ran', 'Tau Ceti', "Barnard's Star", 'Sirius'],
      'Nebulae': ['Orion Nebula', 'Lagoon Nebula', 'Carina Nebula', 'Ring Nebula', 'Crab Nebula', 'Veil Nebula'], 'Black holes': ['Sagittarius A*', 'Cygnus X-1'],
      'Galaxies': ['Milky Way', 'Andromeda Galaxy (M31)', 'Triangulum Galaxy (M33)', 'Large Magellanic Cloud', 'Whirlpool Galaxy (M51)', 'Sombrero Galaxy (M104)', 'Messier 87', 'Centaurus A'] };
    $('places').innerHTML = '<option value="">Places…</option>' + Object.entries(groups).map(([g, l]) => `<optgroup label="${g}">${l.map(n => `<option>${n}</option>`).join('')}</optgroup>`).join('');
    $('places').onchange = (e) => { if (e.target.value) this.search(e.target.value); e.target.value = ''; e.target.blur(); };
    $('tPause').onclick = () => { nav.paused = !nav.paused; };
    $('tFast').onclick = () => this.stepRate(1); $('tSlow').onclick = () => this.stepRate(-1);
    $('tRev').onclick = () => { nav.rate = -nav.rate; }; $('tReal').onclick = () => { nav.rate = 1; nav.paused = false; };
    $('tNow').onclick = () => { nav.time = (Date.now() - Date.UTC(2000, 0, 1, 12)) / 1000; };
    const din = $('tDateIn');
    $('tDate').onclick = () => {
      const d = new Date(Date.UTC(2000, 0, 1, 12) + nav.time * 1000);
      if (!isNaN(d)) din.value = d.toISOString().slice(0, 16);
      din.classList.toggle('hidden'); if (!din.classList.contains('hidden')) din.focus();
    };
    din.onchange = () => { const t = Date.parse(din.value + 'Z'); if (!isNaN(t)) nav.time = (t - Date.UTC(2000, 0, 1, 12)) / 1000; };
    $('bShare').onclick = () => {
      const u = new URL(location.href); u.search = '';
      const t = nav.selected || (nav.anchor ? { type: 'body', body: nav.anchor } : null);
      const d = new Date(Date.UTC(2000, 0, 1, 12) + nav.time * 1000);
      if (!isNaN(d)) u.searchParams.set('date', d.toISOString().slice(0, 16) + 'Z');
      const ll = this.latLon();
      if (ll && nav.altitude < nav.anchor.radius * 0.05) { u.searchParams.set('goto', nav.anchor.name); u.searchParams.set('land', ll[0].toFixed(3) + ',' + ll[1].toFixed(3)); }
      else if (t) u.searchParams.set('goto', targetName(t));
      const txt = u.toString();
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => this.toast('Link copied'), () => prompt('Link to this place', txt));
    };
  }
  toast(msg) { const t = this.root.appendChild(el('div', 'toast', msg)); setTimeout(() => t.classList.add('fade'), 1400); setTimeout(() => t.remove(), 3200); }
  // planetographic latitude/longitude of the camera over the anchor body (degrees)
  latLon() {
    const nav = this.nav, b = nav.anchor; if (!b || !b.wrot) return null;
    const d = Q.rot(Q.conj(b.wrot), V.norm(V.sub(nav.S, b.wpos)));
    return [Math.asin(clamp(d[1], -1, 1)) * 180 / Math.PI, Math.atan2(-d[2], d[0]) * 180 / Math.PI];
  }
  toggle(p) { const was = p.classList.contains('hidden'); [this.sysPanel, this.setPanel, this.help].forEach(q => q.classList.add('hidden')); if (was) p.classList.remove('hidden'); if (p === this.sysPanel) this.sysKey = null; }
  stepRate(d) {
    const nav = this.nav, a = Math.abs(nav.rate), sg = nav.rate < 0 ? -1 : 1;
    let i = RATES.findIndex(r => r >= a * 0.999); if (i < 0) i = RATES.length - 1;
    i = clamp(i + d, 0, RATES.length - 1); nav.rate = RATES[i] * sg; nav.paused = false;
  }
  search(text) { const t = findByName(this.nav, text); if (t) { this.nav.selected = t; this.nav.goTo(t); } }
  // travel to a random interesting place
  explore() {
    const nav = this.nav, rng = new RNG((Math.random() * 1e9) | 0);
    if (nav.field && nav.level !== 'universe') {
      // pick a random star in view range and visit one of its planets
      const cam = nav.camLocal(); let tries = 0, desc = null;
      while (tries++ < 60 && !desc) { const d = nav.field.pick(cam, rng.dir(), 0.25); if (d && !d.sol && (!nav.system || d.key !== nav.system.desc.key)) desc = d; }
      if (desc) { nav.goTo({ type: 'star', desc }); return; }
    }
    nav.goTo({ type: 'galaxy', galaxy: rng.pick(REAL_GALAXIES) });
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
    if (this.hidden) return;
    const nav = this.nav, r = this.r;
    // status
    const loc = nav.level === 'system' ? nav.system.name : nav.level === 'galaxy' ? galaxyName(nav.galaxy) : 'Intergalactic space';
    const date = new Date(Date.UTC(2000, 0, 1, 12) + nav.time * 1000);
    const dstr = isNaN(date) ? 'Year ' + (2000 + nav.time / C.YEAR).toExponential(4) : date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    let alt = '';
    if (nav.anchor && nav.altitude < nav.anchor.radius * 30) {
      alt = `<div><b>Altitude</b> ${fmtDist(nav.altitude)} · ${nav.anchor.name}</div>`;
      const ll = this.latLon();
      if (ll && nav.altitude < nav.anchor.radius * 0.5 && nav.anchor.kind !== 'star') alt += `<div><b>Position</b> ${Math.abs(ll[0]).toFixed(3)}° ${ll[0] >= 0 ? 'N' : 'S'}, ${Math.abs(ll[1]).toFixed(3)}° ${ll[1] >= 0 ? 'E' : 'W'}</div>`;
    }
    this.status.innerHTML = `<div><b>${loc}</b></div>${alt}<div><b>Speed</b> ${fmtSpeed(nav.speedNow)} <span class="dim">(set ${fmtSpeed(nav.speed)})</span></div><div class="dim">${Math.round(this.fps)} fps · EV ${(-Math.log2(r.exposure)).toFixed(1)}${r.stats.pending ? ' · loading ' + r.stats.pending : ''}</div>`;
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
    const key = t.type + ':' + targetName(t);
    if (key !== this.lastInfoKey) {
      this.lastInfoKey = key;
      let rows = [], sub = '';
      if (t.type === 'body') { rows = describeBody(t.body); sub = t.body.kind === 'star' ? 'Star' : t.body.kind[0].toUpperCase() + t.body.kind.slice(1); if (t.body.parent && t.body.parent.kind !== 'barycenter') sub += ' of ' + t.body.parent.name; }
      else if (t.type === 'star') { const s = t.desc.star; sub = 'Star'; rows = [['Class', s.cls], ['Temperature', Math.round(s.T) + ' K'], ['Mass', (s.mass / C.Msun).toPrecision(3) + ' M<sub>Sun</sub>'], ['Radius', (s.radius / C.Rsun).toPrecision(3) + ' R<sub>Sun</sub>'], ['Luminosity', s.lum.toPrecision(3) + ' L<sub>Sun</sub>'], ['Abs. magnitude', s.MV.toFixed(2)]]; }
      else if (t.type === 'nebula') { const nb = t.neb; sub = ['Emission nebula', 'Planetary nebula', 'Supernova remnant'][nb.type]; rows = [['Diameter', (nb.radius * 2 * 3.2616).toPrecision(3) + ' ly']]; }
      else { const g = t.galaxy; sub = 'Galaxy'; rows = [['Type', g.subtype], ['Diameter', (g.radius * 2 * 3.2616 / 1000).toPrecision(3) + ' kly'], ['Stellar mass', g.mass.toExponential(1) + ' M<sub>Sun</sub>'], ['Stars', '~' + g.nstars.toExponential(1)]]; }
      this.info.innerHTML = `<h2>${targetName(t)}</h2><div class="sub">${sub}</div><table>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}<tr><td>Distance</td><td id="iDist"></td></tr>${t.type === 'star' ? '<tr><td>App. magnitude</td><td id="iMag"></td></tr>' : ''}</table>`;
    }
    const d = document.getElementById('iDist'); if (d) d.textContent = fmtDist(dist);
    const m = document.getElementById('iMag'); if (m) m.textContent = (t.desc.star.MV + 5 * Math.log10(dist / C.PC) - 5).toFixed(2);
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
    if (this.showLabels) {
      if (nav.system && nav.level === 'system') {
        for (const b of nav.system.bodies) {
          if (b.kind === 'barycenter' || !b.rel) continue;
          const px = b.pxRadius || 0;
          if (px > 60) continue;
          if (b.kind === 'moon' || (b.parent && b.parent.kind === 'planet')) { const pd = b.parent.dist || 1e30; if (b.orbit.a / pd * r.pxPerRad < 25) continue; }
          if ((b.kind === 'dwarf' || b.kind === 'comet') && b.orbit && b.orbit.a / (b.parent.dist || 1) * r.pxPerRad < 60 && b.dist > b.orbit.a * 0.2) continue;
          if (b.kind === 'planet' && b.orbit.a / Math.max(b.parent.dist || 1, 1) * r.pxPerRad < 9) continue;
          put(b.rel, b.name, b.kind, Math.max(6, px + 4));
        }
      }
      if (nav.level !== 'system' || (nav.system && V.len(nav.S) > 3e13)) {
        const cu = nav.camU();
        for (const g of REAL_GALAXIES) { const rel = V.sub(g.posU, cu), d = V.len(rel); if (d < g.radius * 1.5e-6) continue; if (g.radius * 1e-6 / d * r.pxPerRad > 3) put(rel, g.name, 'galaxy', 10); }
      }
      // star, constellation and nebula labels only when the sky is dark enough to show them
      const darkSky = r.exposure > 2000;
      if (darkSky && nav.galaxy === MILKY_WAY && nav.level !== 'universe' && catalog.ready) {
        const cam = nav.camLocal(), gq = nav.galaxy.quat, d = catalog.data;
        const ds = V.dist(cam, SUN_POS);
        if (ds < 300) {
          const rel = (i) => Q.rot(gq, [SUN_POS[0] + d[i * 5] - cam[0], SUN_POS[1] + d[i * 5 + 1] - cam[1], SUN_POS[2] + d[i * 5 + 2] - cam[2]]);
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
            if (m < 1.6 && !/^(HIP|HYG) /.test(n.name)) { put(r, n.name, 'star', 7); nlab++; }
          }
        }
      }
      if (darkSky && nav.level !== 'universe' && nav.galaxy) {
        for (const v of visibleNebulae) if (v.px > 6 && v.px < 500 && v.nb.name) put(v.rel, v.nb.name, 'galaxy', Math.min(v.px, 60) + 6);
      }
    }
    // selection marker
    const t = nav.selected; let shown = false;
    if (t) {
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
