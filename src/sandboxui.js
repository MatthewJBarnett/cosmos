// Sandbox panel: scenarios, placing bodies, live numbers, a gravitational wave scope and an audible chirp.
import { V, Q, C, clamp } from './math.js';
import { Sandbox, PRESETS, ejecta } from './sandbox.js';
import { MSUN } from './nbody.js';
import { fmtDist, fmtSpeed } from './ui.js';
import { YEAR } from './galdyn.js';

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const KINDS = { bh: ['Black hole', 30, 'M☉'], ns: ['Neutron star', 1.4, 'M☉'], star: ['Star', 1, 'M☉'], wd: ['White dwarf', 0.6, 'M☉'], planet: ['Planet', 1, 'M⊕'] };
const fmtT = (s) => { const a = Math.abs(s); return a < 1 ? (s * 1000).toFixed(1) + ' ms' : a < 120 ? s.toFixed(2) + ' s' : a < 7200 ? (s / 60).toFixed(1) + ' min' : a < 3 * 86400 ? (s / 3600).toFixed(1) + ' h' : a < 2 * YEAR ? (s / 86400).toFixed(1) + ' d' : (s / YEAR).toPrecision(4) + ' yr'; };
const fmtF = (f) => f >= 1 ? f.toPrecision(3) + ' Hz' : f >= 1e-3 ? (f * 1e3).toPrecision(3) + ' mHz' : f >= 1e-6 ? (f * 1e6).toPrecision(3) + ' µHz' : (f * 1e9).toPrecision(3) + ' nHz';

export class SandboxUI {
  constructor(ui) {
    this.ui = ui; this.nav = ui.nav; this.sb = null; this.placing = null; this.audio = null; this.presets = PRESETS;
    const p = this.panel = ui.root.appendChild(el('div', 'panel sandbox hidden'));
    p.innerHTML = `<h3>Physics sandbox</h3>
      <div class="sbrow"><select id="sbPreset" style="width:100%">${PRESETS.map((x, i) => `<option value="${i}">${x.name}</option>`).join('')}</select></div>
      <div class="sbrow"><button id="sbStart">Start scenario</button><button id="sbRestart">Restart</button><button id="sbClear">Empty space</button></div>
      <div class="dim sbtext" id="sbText"></div>
      <div class="sbrow"><select id="sbKind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}</select>
        <input id="sbMass" type="number" min="0.001" step="any" value="30"> <span id="sbUnit">M☉</span><label id="sbSpinL" title="Black hole spin, aligned with the orbit (-1 to 1)">χ <input id="sbSpin" type="number" min="-0.99" max="0.99" step="0.1" value="0" style="width:52px"></label><button id="sbPlace" title="Click in the view to place; drag to set its velocity">Place</button><label title="A plain click places the body at rest instead of on a circular orbit"><input type="checkbox" id="sbRest"> At rest</label></div>
      <div class="sbrow"><label><input type="checkbox" id="sbGrid" checked> Spacetime grid</label><label><input type="checkbox" id="sbTrails" checked> Trails</label><label><input type="checkbox" id="sbFollow" checked> Follow</label><label><input type="checkbox" id="sbAudio"> Sound</label></div>
      <div class="sbrow"><button id="sbSlow" title="Slow motion">½× speed</button><button id="sbFast" title="Faster">2× speed</button><span class="dim" id="sbClock"></span></div>
      <div id="sbBodies" class="sbbodies"></div>
      <canvas id="sbScope" width="380" height="96"></canvas>
      <div id="sbStats" class="sbstats"></div>`;
    const q = (id) => p.querySelector('#' + id);
    this.q = q;
    q('sbPreset').onchange = () => { q('sbText').textContent = PRESETS[+q('sbPreset').value].text; };
    q('sbText').textContent = PRESETS[0].text;
    q('sbStart').onclick = () => this.start(+q('sbPreset').value);
    q('sbRestart').onclick = () => { if (this.sb && this.sb.preset) this.start(PRESETS.indexOf(this.sb.preset)); };
    q('sbClear').onclick = () => this.start(PRESETS.findIndex(x => x.id === 'empty'));
    q('sbKind').onchange = () => { const k = KINDS[q('sbKind').value]; q('sbMass').value = k[1]; q('sbUnit').textContent = k[2]; q('sbSpinL').style.display = q('sbKind').value === 'bh' ? '' : 'none'; };
    q('sbPlace').onclick = () => { if (!this.sb || this.nav.system !== this.sb) this.start(PRESETS.findIndex(x => x.id === 'empty')); this.placing = { kind: q('sbKind').value }; this.ui.toast('Click to place. Drag to give it a velocity.'); };
    q('sbGrid').onchange = (e) => { if (this.sb) this.sb.grid = e.target.checked; };
    q('sbTrails').onchange = (e) => { if (this.sb) this.sb.trailsOn = e.target.checked; };
    q('sbFollow').onchange = (e) => { if (this.sb) this.sb.follow = e.target.checked; };
    q('sbAudio').onchange = (e) => this.setAudio(e.target.checked);
    q('sbSlow').onclick = () => { this.nav.rate /= 2; this.nav.paused = false; };
    q('sbFast').onclick = () => { this.nav.rate *= 2; this.nav.paused = false; };
    this.scope = q('sbScope').getContext('2d');
  }
  toggle() { const was = this.panel.classList.contains('hidden'); if (was) [this.ui.sysPanel, this.ui.setPanel, this.ui.help, this.ui.linePanel].forEach(q => q.classList.add('hidden')); this.panel.classList.toggle('hidden'); if (was && (!this.sb || this.nav.system !== this.sb)) this.start(+this.q('sbPreset').value); }
  start(i) {
    const p = PRESETS[i], nav = this.nav;
    if (!this.sb) {
      this.sb = new Sandbox();
      this.sb.onEvent = (e) => { this.ui.toast(e.note); this.lastEvent = e; };
      this.sb.onRate = (r) => { nav.rate = r; };
      this.sb.onShift = (d) => { if (nav.system === this.sb && !nav.anchor && !nav.goto) nav.S = V.add(nav.S, d); };
    }
    const sb = this.sb;
    this.q('sbPreset').value = i; this.q('sbText').textContent = p.text;
    // scenarios run against today's sky (the sandbox sits half a parsec from the Sun)
    const now = (Date.now() - Date.UTC(2000, 0, 1, 12)) / 1000;
    if (Math.abs(nav.time - now) > 1000 * YEAR) nav.time = now;
    const r = sb.load(p);
    sb.grid = r.grid; this.q('sbGrid').checked = r.grid; sb.trailsOn = this.q('sbTrails').checked; sb.follow = this.q('sbFollow').checked;
    // camera above the orbital plane, looking at the centre of mass
    const D = r.scale * (r.cam || (p.id === 'empty' ? 30 : p.id === 'tde' ? 5 : 4.2)), dir = V.norm([0.15, 0.62, 0.77]);
    nav.enterCustomSystem(sb, V.mul(dir, D), Q.look(V.mul(dir, -1), [0, 1, 0]));
    nav.rate = r.rate; nav.paused = false; nav.speed = D * 0.3;
    this.lastEvent = null; this.ampMax = 0;
    this.ui.toast(p.name);
  }
  // pointer handling while placing a body. Returns true if the event was consumed.
  pointer(type, x, y) {
    if (!this.placing || !this.sb || this.nav.system !== this.sb) { this.placing = null; return false; }
    const nav = this.nav, ray = this.ui.ray(x, y), o = nav.S;
    // intersect with the orbital plane through the centre of mass
    const cm = this.sb.com(), t = (cm[1] - o[1]) / ray[1];
    if (!(t > 0)) return true;
    const pt = V.add(o, V.mul(ray, t));
    if (type === 'down') { this.placing.at = pt; this.placing.drag = pt; this.sb.ghost = this.placing; }
    else if (type === 'move' && this.placing.at) this.placing.drag = pt;
    else if (type === 'up' && this.placing.at) {
      const kind = this.placing.kind, k = KINDS[kind], mv = +this.q('sbMass').value || k[1];
      const m = mv * (kind === 'planet' ? C.Mearth : MSUN);
      const at = this.placing.at, dv = V.sub(pt, at), dl = V.len(dv);
      let v;
      const others = this.sb.sim.bodies.length > 0;
      if (dl < V.len(V.sub(at, o)) * 0.01 || !others) v = others && !this.q('sbRest').checked ? this.sb.circularVelocity(at, m) : [0, 0, 0];
      else {
        // drag length equal to the distance from the centre of mass gives the circular speed, along the drag
        let M = 0; for (const b of this.sb.sim.bodies) M += b.m;
        const rr = Math.max(V.len(V.sub(at, cm)), 1), vc = Math.sqrt(C.G * (M + m) / rr);
        v = V.mul(V.norm(dv), vc * dl / rr);
      }
      const n = this.sb.sim.bodies.filter(b => b.kind === kind).length + 1;
      const chi = kind === 'bh' ? Math.max(-0.99, Math.min(0.99, +this.q('sbSpin').value || 0)) : 0;
      this.sb.addBody(kind, m, at, v, k[0] + ' ' + n + ' (' + mv + ' ' + k[2] + (chi ? ', χ ' + chi : '') + ')', chi);
      this.sb.gridR = null;
      this.placing = null; this.sb.ghost = null;
    }
    return true;
  }
  setAudio(on) {
    if (!on) { if (this.audio) { this.audio.g.gain.value = 0; this.audio.ctx.suspend(); } return; }
    if (!this.audio) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
      osc.type = 'sine'; lp.type = 'lowpass'; lp.frequency.value = 2000; g.gain.value = 0;
      osc.connect(lp); lp.connect(g); g.connect(ctx.destination); osc.start();
      this.audio = { ctx, osc, g };
    }
    this.audio.ctx.resume();
  }
  update() {
    const sb = this.sb, nav = this.nav;
    if (!sb) return;
    const inside = nav.system === sb;
    // a selected body that merged away: select what it became (the most massive body)
    const sel = nav.selected && nav.selected.type === 'body' ? nav.selected.body : null;
    // expanding supernova or kilonova ejecta push the camera back so the explosion stays in view
    if (inside && !nav.paused && !nav.goto) for (const [x, R] of ejecta(sb)) {
      const xw = Q.rot(sb.worldQ, x), rel = V.sub(nav.S, xw), d = V.len(rel);
      if (d < 3 * R && d > 0) { const nd = Math.min(3 * R, d * 1.08); nav.S = V.add(xw, V.mul(rel, nd / d)); }
    }
    const phys = sb.bodies.filter(b => b.phys);
    if (inside && sel && sel.sandbox && !sb.bodies.includes(sel) && phys.length) nav.selected = { type: 'body', body: phys.reduce((a, b) => (b.mass > a.mass ? b : a)) };
    if (this.audio && this.q('sbAudio').checked) {
      // the chirp: gravitational wave frequency (time scaled by the simulation rate) with the strain envelope
      const buf = sb.sim.gw.buf, s = buf[buf.length - 1];
      let f = 0, a = 0;
      if (s && inside && !nav.paused) { f = s.f * Math.abs(nav.rate); const h = sb.sim.gw.strain(s); a = Math.hypot(h[0], h[1]); this.ampMax = Math.max(this.ampMax * 0.9995, a); }
      const audible = f > 25 && f < 6000;
      const t = this.audio.ctx.currentTime;
      this.audio.osc.frequency.setTargetAtTime(clamp(f, 25, 6000), t, 0.01);
      this.audio.g.gain.setTargetAtTime(audible && this.ampMax > 0 ? 0.25 * a / this.ampMax : 0, t, 0.02);
    }
    if (this.panel.classList.contains('hidden') || !inside) return;
    // body list: select or remove
    const key = sb.sim.bodies.map(b => b.id).join(',');
    if (key !== this.bodyKey) {
      this.bodyKey = key;
      const box = this.q('sbBodies');
      box.innerHTML = sb.sim.bodies.map(b => `<div class="sbb" data-id="${b.id}"><span class="nm">${b.name}</span><span class="dim">${b.m > 1e28 ? (b.m / MSUN).toPrecision(3) + ' M☉' : (b.m / C.Mearth).toPrecision(3) + ' M⊕'}</span><button title="Remove">×</button></div>`).join('');
      box.querySelectorAll('.sbb').forEach(row => {
        const id = +row.dataset.id;
        row.querySelector('.nm').onclick = () => { const r = sb.map.get(id); if (r) { nav.selected = { type: 'body', body: r }; } };
        row.querySelector('button').onclick = () => { const pb = sb.sim.bodies.find(b => b.id === id); if (pb) { sb.sim.remove(pb); sb.sync(); sb.snapshot(); sb.gridR = null; } };
      });
    }
    const st = sb.stats();
    this.q('sbClock').textContent = 'T = ' + fmtT(st.t) + (sb.lag ? ' · simulation can\'t keep up' : '');
    let html = '';
    if (st.pair) {
      html += `<div><b>${st.pair[0]}</b> – <b>${st.pair[1]}</b></div>`;
      html += `<div>Separation ${fmtDist(st.r)} · relative speed ${fmtSpeed(st.v)} (${(st.v / C.c).toFixed(3)} c)</div>`;
      if (st.period) html += `<div>Orbital period ${fmtT(st.period)} · GW frequency ${fmtF(st.fgw)}</div>`;
      if (st.Pgw > 1e10) html += `<div>GW luminosity ${st.Pgw.toExponential(2)} W (${(st.Pgw / C.Lsun).toExponential(1)} L☉)</div>`;
      if (st.tmerge) html += `<div>Time to merger (Peters) ${fmtT(st.tmerge)}</div>`;
    } else html += '<div class="dim">Place at least two bodies.</div>';
    if (st.h) html += `<div>Strain at 100 Mpc, face-on: h ≈ ${Math.hypot(st.h[0], st.h[1]).toExponential(2)}</div>`;
    const e = this.lastEvent;
    if (e) {
      html += `<div class="sbev">${e.note}</div>`;
      if (e.fRD) html += `<div>Final mass ${(e.mf / MSUN).toFixed(2)} M☉ · spin ${e.chi.toFixed(2)} · radiated ${(e.Erad / MSUN).toFixed(2)} M☉c² · kick ${(e.kick / 1e3).toFixed(0)} km/s · ringdown ${fmtF(e.fRD)}, τ = ${fmtT(e.tau)}</div>`;
      if (e.kilonova) html += '<div class="dim">Kilonova: speed time up to days to watch it brighten and redden.</div>';
    }
    this.q('sbStats').innerHTML = html;
    this.drawScope(sb);
  }
  drawScope(sb) {
    const g = this.scope, W = g.canvas.width, H = g.canvas.height, buf = sb.sim.gw.buf;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(160,190,230,0.25)'; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W - 92, H / 2); g.stroke();
    if (buf.length < 2) return;
    const tEnd = buf[buf.length - 1].t, f = buf[buf.length - 1].f || 1;
    // show about 10 cycles, but keep the view from zooming too fast
    const want = clamp(10 / Math.max(f, 1e-12), 1e-4, 1e12);
    this.win = this.win ? this.win * 0.97 + want * 0.03 : want;
    const t0 = tEnd - this.win;
    let amax = 1e-40; const pts = [];
    for (let i = buf.length - 1; i >= 0 && buf[i].t >= t0; i--) { const h = sb.sim.gw.strain(buf[i])[0]; pts.push([buf[i].t, h]); amax = Math.max(amax, Math.abs(h)); }
    this.amax = this.amax ? Math.max(amax, this.amax * 0.98) : amax;
    g.strokeStyle = '#7fd4ff'; g.lineWidth = 1.3; g.beginPath();
    pts.reverse().forEach(([t, h], i) => { const x = (t - t0) / this.win * (W - 92), y = H / 2 - h / this.amax * H * 0.42; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.stroke();
    g.fillStyle = 'rgba(200,220,255,0.7)'; g.font = '11px system-ui';
    g.fillText('h₊ at 100 Mpc (face-on)  ±' + this.amax.toExponential(1), 6, 13);
    g.fillText(fmtT(this.win), W - 140, H - 5);
    // a ring of free test masses as the wave passes (deformation exaggerated): + stretches along x and squeezes
    // along y, x does the same rotated by 45 degrees
    const last = buf[buf.length - 1], h = sb.sim.gw.strain(last), k = 0.28 / Math.max(this.amax, 1e-40);
    const cx = W - 46, cy = H / 2 + 4, R = 26;
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(cx - 40, cy - 40, 80, 80);
    g.fillStyle = '#ffd38a';
    for (let i = 0; i < 16; i++) {
      const a = i / 16 * 2 * Math.PI, x = Math.cos(a), y = Math.sin(a);
      const dx = (h[0] * x + h[1] * y) * k, dy = (-h[0] * y + h[1] * x) * k;
      g.beginPath(); g.arc(cx + (x + dx) * R, cy + (y + dy) * R, 1.8, 0, 2 * Math.PI); g.fill();
    }
  }
}
