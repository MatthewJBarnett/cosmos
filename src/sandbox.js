// Physics sandbox: place black holes, neutron stars, stars and planets anywhere, press play and watch gravity work.
// Dynamics come from nbody.js (post-Newtonian with radiation reaction, merger fits). This module turns the
// simulation into a star system the renderer understands, and draws trails and a spacetime grid that carries
// the actual retarded gravitational wave field of the system.
import { gl, Program, makeVAO } from './gl.js';
import { V, Q, C, clamp } from './math.js';
import { RNG } from './rng.js';
import { KIND, bbColor } from './stars.js';
import { makeStarBody, body as mkBody, surfacePreset } from './system.js';
import { MILKY_WAY, SUN_POS } from './universe.js';
import { galQuat0, toPattern, world, YEAR } from './galdyn.js';
import { LOGDEPTH_VS, LOGDEPTH_FS } from './planet.js';
import { beam } from './exotic.js';
import { NBody, makeBody, binary, separationForTime, circularBinary, petersTime, MSUN } from './nbody.js';

const G = C.G, c = C.c, AU = C.AU, DAY = 86400;
export const SANDBOX_POS = [SUN_POS[0] + 0.7, SUN_POS[1] + 0.4, SUN_POS[2] + 0.5];

// main sequence star of mass m (kg): luminosity and radius from mass, temperature from Stefan-Boltzmann
function msStar(m) {
  const q = m / MSUN;
  const L = q < 0.43 ? 0.23 * q ** 2.3 : q < 2 ? q ** 4 : q < 55 ? 1.4 * q ** 3.5 : 32000 * q;
  const R = q < 1 ? q ** 0.8 : q ** 0.57;
  const T = 5772 * Math.pow(L / (R * R), 0.25);
  const sp = T > 30000 ? 'O' : T > 10000 ? 'B' : T > 7500 ? 'A' : T > 6000 ? 'F' : T > 5200 ? 'G' : T > 3700 ? 'K' : 'M';
  return { kind: KIND.MS, MV: 4.83 - 2.5 * Math.log10(L), T, mass: m, radius: R * C.Rsun, lum: L, cls: sp + '-type main sequence star' };
}

// ---------- scenarios ----------
// Each sets up bodies and returns { rate (s/s), view: distance in units of the scale, scale (m), grid }
export const PRESETS = [
  { id: 'gw150914', name: 'Binary black hole merger (like GW150914)', text: 'Black holes of 36 and 29 solar masses, 2,400 km apart, spiral together as they radiate gravitational waves, merge and ring down. Real time: the last orbits take a fraction of a second.',
    setup(sim) { const a = separationForTime(36 * MSUN, 29 * MSUN, 12); binary(sim, 'bh', 36 * MSUN, 'bh', 29 * MSUN, a, { n1: 'Black hole A (36 M☉)', n2: 'Black hole B (29 M☉)' }); return { rate: 0.25, scale: a, grid: true }; } },
  { id: 'unequal', name: 'Unequal black holes (8 : 1)', text: 'A 40 and a 5 solar mass black hole. Unequal masses radiate momentum asymmetrically: the remnant is kicked at tens of km/s.',
    setup(sim) { const a = separationForTime(40 * MSUN, 5 * MSUN, 10); binary(sim, 'bh', 40 * MSUN, 'bh', 5 * MSUN, a, { n1: 'Black hole (40 M☉)', n2: 'Black hole (5 M☉)' }); return { rate: 0.25, scale: a, grid: true }; } },
  { id: 'eccentric', name: 'Eccentric black hole binary', text: 'Two 20 solar mass black holes on an eccentric orbit. General relativity turns the ellipse into a rosette (periastron precession), and each close passage emits a burst of gravitational waves before the orbit circularises.',
    setup(sim) { const rp = 1000e3; binary(sim, 'bh', 20 * MSUN, 'bh', 20 * MSUN, rp, { n1: 'Black hole A (20 M☉)', n2: 'Black hole B (20 M☉)', e: 0.6 }); return { rate: 0.25, scale: rp * 2.5, grid: true }; } },
  { id: 'gw170817', name: 'Neutron star merger (like GW170817)', text: 'Neutron stars of 1.46 and 1.27 solar masses spiral in at a third of the speed of light. The merger collapses to a black hole and throws out a kilonova.',
    setup(sim) { const a = separationForTime(1.46 * MSUN, 1.27 * MSUN, 6); binary(sim, 'ns', 1.46 * MSUN, 'ns', 1.27 * MSUN, a, { n1: 'Neutron star A', n2: 'Neutron star B' }); return { rate: 0.1, scale: a, grid: true }; } },
  { id: 'smbh', name: 'Supermassive black hole binary', text: 'Two million solar mass black holes, the kind LISA will hear: millihertz waves, merging in about a day.',
    setup(sim) { const a = separationForTime(1e6 * MSUN, 1e6 * MSUN, 1.2 * DAY); binary(sim, 'bh', 1e6 * MSUN, 'bh', 1e6 * MSUN, a, { n1: 'SMBH A', n2: 'SMBH B' }); return { rate: 3600, scale: a, grid: true }; } },
  { id: 'tde', name: 'Star torn apart by a black hole (TDE)', text: 'A Sun-like star on a parabolic orbit passes inside the tidal radius of a million solar mass black hole and is shredded; half the debris returns to feed the hole.',
    setup(sim) {
      const Mb = 1e6 * MSUN, ms = MSUN, rt = C.Rsun * Math.cbrt(Mb / ms), rp = 0.5 * rt, r0 = 6 * rt;
      // parabolic orbit with pericentre rp: place at r0 on the incoming branch
      const p = 2 * rp, cosf = p / r0 - 1, f = -Math.acos(clamp(cosf, -1, 1));
      const x = [r0 * Math.cos(f), 0, r0 * Math.sin(f)], vk = Math.sqrt(G * Mb / p);
      const v = [-vk * Math.sin(f), 0, vk * (1 + Math.cos(f))];
      sim.add(makeBody('bh', Mb, [0, 0, 0], [0, 0, 0], { name: 'Black hole (10⁶ M☉)' }));
      sim.add(makeBody('star', ms, x, v, { name: 'Sun-like star' }));
      return { rate: 600, scale: rt * 3, grid: true, later: [{ t: 3 * DAY, rate: DAY }] };
    } },
  { id: 'fig8', name: 'Figure-eight three-body orbit', text: 'Three equal stars chasing each other on one figure-eight path (Chenciner and Montgomery, 2000). A rare stable solution of the three-body problem.',
    setup(sim) {
      const L = AU, m = MSUN, T = Math.sqrt(L ** 3 / (G * m));
      const p = [[-0.97000436, 0.24308753], [0.97000436, -0.24308753], [0, 0]], v3 = [-0.93240737, -0.86473146];
      const vv = [[-v3[0] / 2, -v3[1] / 2], [-v3[0] / 2, -v3[1] / 2], v3];
      sim.pn = false;
      for (let i = 0; i < 3; i++) sim.add(makeBody('star', m, [p[i][0] * L, 0, p[i][1] * L], [vv[i][0] * L / T, 0, vv[i][1] * L / T], { name: 'Star ' + 'ABC'[i] }));
      return { rate: 5 * DAY, scale: L, grid: false };
    } },
  { id: 'burrau', name: 'Pythagorean three-body problem', text: 'Stars of 3, 4 and 5 solar masses start at rest at the corners of a 3-4-5 triangle (Burrau, 1913). Chaos, close encounters, then a binary and an escaping star.',
    setup(sim) {
      const L = 40 * AU, mu = MSUN;
      [[3, 1, 3], [4, -2, -1], [5, 1, -1]].forEach(([m, x, y], i) => sim.add(makeBody('star', m * mu, [x * L, 0, y * L], [0, 0, 0], { name: m + ' M☉ star' })));
      sim.pn = false;
      return { rate: 20 * YEAR, scale: 3 * L, grid: false };
    } },
  { id: 'tatooine', name: 'Planet around a binary star', text: 'A circumbinary planet like Kepler-16b: a K and an M dwarf in a 41 day orbit, with a planet 0.7 AU out.',
    setup(sim) {
      const m1 = 0.69 * MSUN, m2 = 0.2 * MSUN, a = 0.224 * AU; binary(sim, 'star', m1, 'star', m2, a, { n1: 'Kepler-16 A', n2: 'Kepler-16 B' });
      const M = m1 + m2, r = 0.705 * AU, v = Math.sqrt(G * M / r);
      sim.add(makeBody('planet', 105 * C.Mearth, [0, 0, r], [v, 0, 0], { name: 'Planet' }));
      sim.pn = false;
      return { rate: 2 * DAY, scale: r * 1.2, grid: false };
    } },
  { id: 'bhstar', name: 'Black hole and a star collide', text: 'A 10 solar mass black hole falls towards a red dwarf: the star is shredded as it passes inside the tidal radius.',
    setup(sim) {
      sim.add(makeBody('bh', 10 * MSUN, [-2e9, 0, 0], [0, 0, 0], { name: 'Black hole (10 M☉)' }));
      sim.add(makeBody('star', 0.3 * MSUN, [2e9, 0, 3e8], [-2.0e5, 0, 0], { name: 'Red dwarf' }));
      return { rate: 300, scale: 4e9, grid: true };
    } },
  { id: 'empty', name: 'Empty space (place your own)', text: 'Choose a body type and mass, then click to place it. Drag while placing to give it a velocity; a plain click puts it on a circular orbit.',
    setup(sim) { return { rate: 1, scale: 1e7, grid: true }; } },
];

// ---------- the sandbox "star system" ----------
export class Sandbox {
  constructor() {
    const g = MILKY_WAY;
    this.desc = { galaxy: g, seed: 0x5a9d, pos: SANDBOX_POS.slice(), key: g.id + '/sandbox', name: 'Sandbox', sandbox: true, star: { kind: 0, MV: 99, T: 5000, mass: MSUN, radius: 1e3, lum: 0, cls: 'Sandbox' } };
    this.galaxy = g; this.name = 'Sandbox'; this.sandbox = true;
    this.quat = Q.ident(); this.worldQ = galQuat0(g);
    this.posGu = Q.rot(galQuat0(g), SANDBOX_POS); this.posLocal = SANDBOX_POS.slice();
    this.bodies = []; this.stars = []; this.belts = []; this.root = null;
    this.map = new Map(); this.trails = new Map(); this.deadTrails = [];
    this.sim = new NBody(); this.snaps = []; this.rng = new RNG(77);
    this.grid = true; this.trailsOn = true; this.follow = true; this.preset = null;
    this.navT = undefined; this.time = 0; this.lag = false; this.events = [];
  }
  load(p) {
    this.sim = new NBody(); this.map.clear(); this.trails.clear(); this.deadTrails = []; this.snaps = []; this.events = [];
    this.sim.onEvent = (e) => { this.events.push(e); if (this.onEvent) this.onEvent(e); };
    const r = p.setup(this.sim); this.preset = p; this.cfg = r;
    this.scale = r.scale; this.grid = r.grid; this.later = (r.later || []).slice();
    this.gridR = null; this.com0 = this.com();
    this.sync(); this.snapshot();
    return r;
  }
  com() { let M = 0; const x = [0, 0, 0]; for (const b of this.sim.bodies) { M += b.m; for (let k = 0; k < 3; k++) x[k] += b.m * b.x[k]; } return M ? x.map(v => v / M) : [0, 0, 0]; }
  snapshot() { this.snaps.push(this.sim.clone()); this.lastSnapSteps = this.sim.steps; if (this.snaps.length > 240) this.snaps = this.snaps.filter((s, i) => i === 0 || i % 2 === 1); }
  // nav.time drives the sandbox clock: forward integrates, backward restores the last snapshot and integrates up
  update(t) {
    this.time = t;
    if (this.navT === undefined) this.navT = t;
    let dt = t - this.navT; this.navT = t;
    // the clock can jump (dates set by hand); a step is limited by maxSteps anyway, but don't try to integrate eons
    if (Math.abs(dt) > 1e15) dt = 0;
    const prevCom = this.follow ? this.com() : null;
    if (dt > 0) {
      const got = this.sim.advance(dt, this.maxSteps || 25000);
      this.lag = got < dt * 0.98;
      if (this.sim.steps - this.lastSnapSteps > 2500 || this.sim.events.length !== (this.snaps.length ? this.snaps[this.snaps.length - 1].events.length : 0)) this.snapshot();
    } else if (dt < 0) this.rewind(this.sim.t + dt);
    if (this.later.length && this.sim.t > this.later[0].t) { const l = this.later.shift(); if (this.onRate) this.onRate(l.rate); }
    if (prevCom && this.onShift) { const nc = this.com(); this.onShift(V.sub(nc, prevCom)); }
    this.sync();
  }
  rewind(target) {
    target = Math.max(target, this.snaps.length ? this.snaps[0].t : 0);
    let i = this.snaps.length - 1; while (i > 0 && this.snaps[i].t > target) i--;
    if (i < 0) return;
    const s = this.snaps[i].clone(); s.onEvent = this.sim.onEvent; s.gw = this.sim.gw;
    this.snaps.length = i + 1;
    s.gw.buf = s.gw.buf.filter(x => x.t <= s.t); s.gw.lastT = s.gw.buf.length ? s.gw.buf[s.gw.buf.length - 1].t : -Infinity; s.gw.rd = null;
    this.events = this.events.filter(e => e.t <= s.t);
    this.sim = s;
    if (target > s.t) this.sim.advance(target - s.t, 200000);
    for (const [id, tr] of this.trails) { while (tr.length && tr[tr.length - 1][3] > this.sim.t) tr.pop(); }
  }
  // mirror simulation bodies as renderable bodies
  sync() {
    const seen = new Set();
    const list = [];
    for (const pb of this.sim.bodies) {
      let b = this.map.get(pb.id);
      if (!b) { b = this.makeRender(pb); this.map.set(pb.id, b); }
      seen.add(pb.id);
      b.phys = pb; b.mass = pb.m; b.pos = pb.x; b.wpos = Q.rot(this.worldQ, pb.x); b.vel = pb.v;
      if (b.rotPeriod) b.rotAngle = 2 * Math.PI * ((this.sim.t / b.rotPeriod) % 1);
      b.rotQ = Q.mul(b.axisQ, Q.axis([0, 1, 0], b.rotAngle || 0)); b.wrot = Q.mul(this.worldQ, b.rotQ);
      if (pb.kind === 'bh') {
        b.radius = pb.R;
        // accretion from tidal debris lights a disk: rate relative to Eddington
        const P = this.sim.particles;
        const mdot = P && P.bhId === pb.id ? P.mdot(this.sim.t) : 0;
        b.accretion = mdot > 0 ? clamp(Math.log10(mdot / (pb.m / MSUN * 1.4e14)) / 3 + 0.6, 0.15, 1) : 0;
        b.lum = mdot > 0 ? Math.min(0.1 * mdot * c * c, 1.26e31 * pb.m / MSUN) / C.Lsun : 0;
      }
      if (pb.flash) { const age = this.sim.t - pb.flash.t; b.lum = b.baseLum * (1 + pb.flash.L * Math.exp(-age / (30 * DAY))); }
      if (pb.kilonova) {
        // kilonova: r-process ejecta expanding at ~0.2 c, peaking after about a day and reddening over a week
        const age = Math.max(this.sim.t - pb.kilonova.t, 1e-3);
        b.knR = 0.2 * c * age; b.knT = clamp(12000 * Math.pow(age / DAY, -0.5), 1800, 30000);
        b.knL = 1e8 * Math.min(1, age / (0.7 * DAY)) * Math.pow(Math.max(age / DAY, 0.7), -1.3);
      }
      const tr = this.trails.get(pb.id) || (this.trails.set(pb.id, []), this.trails.get(pb.id));
      const last = tr[tr.length - 1];
      const step = Math.max(this.trailStep(pb), 1);
      if (!last || Math.hypot(pb.x[0] - last[0], pb.x[1] - last[1], pb.x[2] - last[2]) > step) { tr.push([pb.x[0], pb.x[1], pb.x[2], this.sim.t]); if (tr.length > 1200) tr.shift(); }
      list.push(b);
    }
    for (const [id, b] of this.map) if (!seen.has(id)) { this.map.delete(id); const tr = this.trails.get(id); if (tr) { this.deadTrails.push({ pts: tr, t: this.sim.t }); this.trails.delete(id); } }
    if (this.deadTrails.length > 6) this.deadTrails.splice(0, this.deadTrails.length - 6);
    this.bodies = list; this.stars = list.filter(b => b.kind === 'star');
    this.root = list[0] || null;
  }
  trailStep(pb) {
    // resolve each orbit with ~200 points: step from the distance to the nearest other body
    let d = Infinity; for (const o of this.sim.bodies) if (o !== pb) d = Math.min(d, Math.hypot(o.x[0] - pb.x[0], o.x[1] - pb.x[1], o.x[2] - pb.x[2]));
    return isFinite(d) ? d * 0.02 : this.scale * 0.01;
  }
  makeRender(pb) {
    const rng = this.rng;
    let b;
    if (pb.kind === 'bh') { b = makeStarBody({ kind: KIND.BH, MV: 99, T: 0, mass: pb.m, radius: pb.R, lum: 0, cls: 'Black hole' }, pb.name, rng); b.accretion = 0; b.cls = pb.m > 1e5 * MSUN ? 'Supermassive black hole' : 'Black hole'; if (pb.chi) b.cls += ' (spin ' + pb.chi.toFixed(2) + ')'; }
    else if (pb.kind === 'ns') { const T = 1e6, R = pb.R; b = makeStarBody({ kind: KIND.NS, MV: 99, T, mass: pb.m, radius: R, lum: 4 * Math.PI * R * R * C.sigma * T ** 4 / C.Lsun, cls: 'Neutron star', period: 0.004 }, pb.name, rng); b.pulsar = true; b.rotPeriod = 0.004; }
    else if (pb.kind === 'wd') { const T = 15000, R = pb.R; b = makeStarBody({ kind: KIND.WD, MV: 11, T, mass: pb.m, radius: R, lum: 4 * Math.PI * R * R * C.sigma * T ** 4 / C.Lsun, cls: 'White dwarf' }, pb.name, rng); }
    else if (pb.kind === 'star') { const s = msStar(pb.m); s.radius = pb.R; b = makeStarBody(s, pb.name, rng); b.rotPeriod = 25 * DAY; }
    else {
      b = mkBody({ name: pb.name, kind: 'planet', cls: pb.m > 50 * C.Mearth ? 'Gas giant' : 'Rocky planet', mass: pb.m, radius: pb.R, albedo: 0.3, temp: 250, rotPeriod: 20 * 3600, tilt: 10 });
      b.surface = pb.m > 50 * C.Mearth ? { gen: 'gas', seed: [1, 2, 3], freq: 1, pal: [[0.62, 0.5, 0.36], [0.8, 0.74, 0.62], [0.45, 0.26, 0.14], [0.88, 0.84, 0.76]], bands: 8, bandStr: 1, turb: 1, storms: 0.5, hmin: 0, hmax: 0, lunar: 0, emis: 0 } : surfacePreset('selena', rng, b);
    }
    b.baseLum = b.lum; b.sandbox = true; b.children = []; b.parent = null; b.system = this; b.depth = 0;
    b.pole = [0, 1, 0]; b.axisQ = Q.ident(); b.rotAngle = 0; b.uid = b.uid || Math.floor(Math.random() * 1e9);
    return b;
  }
  find(name) { name = name.toLowerCase(); return this.bodies.find(b => b.name.toLowerCase() === name); }
  // add a body at position x with velocity v (m, m/s, sandbox frame)
  addBody(kind, m, x, v, name) { const pb = makeBody(kind, m, x, v, { name }); this.sim.add(pb); this.sync(); this.snapshot(); return pb; }
  // velocity for a circular orbit at x around everything else
  circularVelocity(x, m) {
    let M = 0; const cm = [0, 0, 0], vc = [0, 0, 0];
    for (const b of this.sim.bodies) { M += b.m; for (let k = 0; k < 3; k++) { cm[k] += b.m * b.x[k]; vc[k] += b.m * b.v[k]; } }
    if (!M) return [0, 0, 0];
    for (let k = 0; k < 3; k++) { cm[k] /= M; vc[k] /= M; }
    const r = V.sub(x, cm), rl = V.len(r); if (rl <= 0) return vc;
    const { vt } = circularBinary(M, m, rl, this.sim.pn);
    const dir = V.norm(V.cross([0, 1, 0], r));
    // the new body gets its share of the relative velocity; the rest is applied to the others
    const vb = V.mul(dir, -vt * M / (M + m)), vo = V.mul(dir, vt * m / (M + m));
    for (const b of this.sim.bodies) for (let k = 0; k < 3; k++) b.v[k] += vo[k];
    return V.add(vb, vc);
  }
  // numbers for the panel
  stats() {
    const B = this.sim.bodies, out = { n: B.length, t: this.sim.t };
    let best = null;
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
      const r = Math.hypot(B[i].x[0] - B[j].x[0], B[i].x[1] - B[j].x[1], B[i].x[2] - B[j].x[2]);
      const s = G * (B[i].m + B[j].m) / r; if (!best || s > best.s) best = { s, i: B[i], j: B[j], r };
    }
    if (best) {
      const a = best.i, b = best.j, M = a.m + b.m, mu = a.m * b.m / M, r = best.r;
      const vrel = Math.hypot(a.v[0] - b.v[0], a.v[1] - b.v[1], a.v[2] - b.v[2]);
      const E = 0.5 * mu * vrel * vrel - G * M * mu / r;
      out.pair = [a.name, b.name]; out.r = r; out.v = vrel; out.bound = E < 0;
      if (E < 0) { const sma = -G * M * mu / (2 * E); out.period = 2 * Math.PI * Math.sqrt(sma ** 3 / (G * M)); out.fgw = 2 / out.period; out.sma = sma; }
      out.Pgw = 32 / 5 * G ** 4 * mu * mu * M ** 3 / (c ** 5 * r ** 5);
      if (E < 0 && (a.kind === 'bh' || a.kind === 'ns') && (b.kind === 'bh' || b.kind === 'ns')) out.tmerge = petersTime(a.m, b.m, r);
    }
    const last = this.sim.gw.buf[this.sim.gw.buf.length - 1];
    if (last) out.h = this.sim.gw.strain(last);
    out.Erad = this.sim.Erad;
    return out;
  }
}

// ---------- drawing: trails and the spacetime grid ----------
const TRAIL_VS = `layout(location=0) in vec3 aPos; layout(location=1) in vec4 aCol; uniform mat4 uViewProj; out vec4 vCol; ${LOGDEPTH_VS}
void main(){ vCol = aCol; gl_Position = uViewProj*vec4(aPos, 1.); logDepth(); }`;
const TRAIL_FS = `in vec4 vCol; out vec4 o; ${LOGDEPTH_FS} void main(){ logDepth(); o = vec4(vCol.rgb*vCol.a, 0.); }`;
// spacetime grid in the orbital (x-z) plane: a gravity well from each mass plus the gravitational wave strain,
// read at the retarded time t - r/c from a texture of the system's quadrupole history
const GRID_VS = `layout(location=0) in vec2 aRP;
uniform mat4 uViewProj; uniform vec3 uCen; uniform float uR0, uRmax, uAmp, uWell, uRef; uniform sampler2D uWave;
uniform vec4 uM[8]; uniform int uNM;
out float vA; out float vH; ${LOGDEPTH_VS}
void main(){
  float lr = log(uRmax/uR0);
  float r = uR0*exp(aRP.x*lr);
  vec2 d = vec2(cos(aRP.y), sin(aRP.y));
  vec3 p = vec3(d.x*r, 0., d.y*r);
  vec4 qa = textureLod(uWave, vec2(aRP.x, 0.25), 0.), qb = textureLod(uWave, vec2(aRP.x, 0.75), 0.);
  // in-plane observer: e1 = plane normal (y), e2 = tangential; h+ ~ (Q_yy - Q_tt)/r
  vec2 e2 = vec2(-d.y, d.x);
  float Qtt = qa.x*e2.x*e2.x + 2.*qb.x*e2.x*e2.y + qa.z*e2.y*e2.y;
  float h = (qa.y - Qtt)*uRef/max(r, uR0);
  float well = 0.;
  for (int i = 0; i < 8; i++) { if (i >= uNM) break; vec3 q = p - uM[i].xyz; float dd = length(q); well -= uM[i].w/sqrt(dd*dd + uRef*uRef*0.36); }
  float y = h*uAmp*sqrt(max(r, uRef)/uRef) + well*uWell;
  vH = h; vA = smoothstep(1., 0.8, aRP.x)*smoothstep(0.3, 1.5, r/uRef);
  gl_Position = uViewProj*vec4(uCen + p + vec3(0., y, 0.), 1.); logDepth();
}`;
const GRID_FS = `in float vA; in float vH; out vec4 o; uniform float uBright; ${LOGDEPTH_FS}
void main(){ logDepth(); float k = clamp(vH*1.2, -1., 1.); vec3 c = mix(vec3(0.18, 0.42, 0.85), k > 0. ? vec3(0.55, 0.9, 1.0) : vec3(0.75, 0.35, 1.0), abs(k)); o = vec4(c*vA*uBright*(0.55 + 0.6*abs(k)), 0.); }`;
let pTrail, trailVAO, trailBuf, pGrid, gridVAO, gridCount = 0, waveTex;
const NW = 512;
function initGrid() {
  pGrid = new Program('sgrid', GRID_VS, GRID_FS);
  const NR = 44, NS = 256, NSP = 48, NRS = 256, pts = [];
  for (let k = 0; k < NR; k++) { const x = k / (NR - 1); for (let i = 0; i < NS; i++) { pts.push(x, i / NS * 6.2831853, x, (i + 1) / NS * 6.2831853); } }
  for (let j = 0; j < NSP; j++) { const ph = j / NSP * 6.2831853; for (let i = 0; i < NRS; i++) pts.push(i / NRS, ph, (i + 1) / NRS, ph); }
  gridVAO = makeVAO([{ data: new Float32Array(pts), size: 2, loc: 0 }]); gridCount = pts.length / 2;
  waveTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, waveTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, NW, 2, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
const waveData = new Float32Array(NW * 2 * 4);

export function initSandboxPrograms() { initTrail(); if (!pGrid) initGrid(); if (!pDeb) pDeb = new Program('debris', DEB_VS, DEB_FS); }
function initTrail() {
  if (pTrail) return;
  pTrail = new Program('trails', TRAIL_VS, TRAIL_FS);
  trailVAO = gl.createVertexArray(); gl.bindVertexArray(trailVAO); trailBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, trailBuf);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
  gl.bindVertexArray(null);
}
// generic coloured line segments: data = [x y z r g b a] per vertex (camera relative), drawn as GL lines
export function drawLines(data, viewProj, fcoef, depth = false) {
  if (!data.length) return;
  initTrail();
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); if (depth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
  gl.bindVertexArray(trailVAO); gl.bindBuffer(gl.ARRAY_BUFFER, trailBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
  pTrail.use().set({ uViewProj: viewProj, uFcoef: fcoef });
  gl.drawArrays(gl.LINES, 0, data.length / 7);
  gl.disable(gl.DEPTH_TEST);
}
export function drawSandbox(sb, nav, o) {
  const camS = nav.S;
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.enable(gl.DEPTH_TEST); gl.depthMask(false);
  // trails
  if (sb.trailsOn) {
    initTrail();
    const data = [];
    const addTrail = (pts, col, fade) => {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], fa = (i - 1) / pts.length, fb = i / pts.length;
        data.push(a[0] - camS[0], a[1] - camS[1], a[2] - camS[2], col[0], col[1], col[2], fa * fa * 0.6 * fade, b[0] - camS[0], b[1] - camS[1], b[2] - camS[2], col[0], col[1], col[2], fb * fb * 0.6 * fade);
      }
    };
    for (const b of sb.bodies) {
      const tr = sb.trails.get(b.phys.id); if (!tr || tr.length < 2) continue;
      const pts = tr.concat([[b.pos[0], b.pos[1], b.pos[2]]]);
      const col = b.blackHole ? [1.0, 0.62, 0.3] : b.neutron ? [0.5, 0.75, 1.0] : b.kind === 'star' ? bbColor(b.temp).map(x => x * 0.9) : [0.5, 0.8, 0.6];
      addTrail(pts, col, 1);
    }
    for (const d of sb.deadTrails) addTrail(d.pts, [0.6, 0.6, 0.6], 0.6);
    if (data.length) {
      gl.bindVertexArray(trailVAO); gl.bindBuffer(gl.ARRAY_BUFFER, trailBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
      pTrail.use().set({ uViewProj: o.viewProj, uFcoef: o.fcoef });
      gl.drawArrays(gl.LINES, 0, data.length / 7);
    }
  }
  // placing a body: marker and velocity arrow
  if (sb.ghost && sb.ghost.at) {
    const a = V.sub(sb.ghost.at, camS), b = V.sub(sb.ghost.drag, camS), s2 = V.len(a) * 0.01;
    const d = [], col = [1, 0.85, 0.4, 0.9];
    const seg = (p, q) => d.push(...p, ...col, ...q, ...col);
    seg(V.add(a, [-s2, 0, 0]), V.add(a, [s2, 0, 0])); seg(V.add(a, [0, 0, -s2]), V.add(a, [0, 0, s2]));
    if (V.dist(a, b) > s2) { seg(a, b); const dir = V.norm(V.sub(b, a)), side = V.cross(dir, [0, 1, 0]); seg(b, V.add(b, V.add(V.mul(dir, -s2 * 1.5), V.mul(side, s2)))); seg(b, V.add(b, V.add(V.mul(dir, -s2 * 1.5), V.mul(side, -s2)))); }
    drawLines(d, o.viewProj, o.fcoef);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.enable(gl.DEPTH_TEST); gl.depthMask(false);
  }
  // spacetime grid
  if (sb.grid && sb.bodies.length) {
    if (!pGrid) initGrid();
    const sim = sb.sim, gw = sim.gw, cm = sb.com();
    // extent: a few gravitational wavelengths of the tightest pair, at least 30 times its separation
    if (!sb.gridR) {
      const st = sb.stats(), sep = st.r || sb.scale, lam = st.fgw ? c / st.fgw : 0;
      const Rmax = Math.min(Math.max(30 * sep, 3.2 * lam, sb.scale * 4), 1e14);
      sb.gridR = { Rmax, R0: Rmax / 1500, ref: sep };
    }
    const { Rmax, R0, ref } = sb.gridR;
    // the retarded quadrupole history on the grid's logarithmic radius
    let qmax = 1e-30;
    for (const s of gw.buf) for (const v of s.q) qmax = Math.max(qmax, Math.abs(v));
    const lr = Math.log(Rmax / R0);
    for (let i = 0; i < NW; i++) {
      const r = R0 * Math.exp(i / (NW - 1) * lr), s = gw.at(sim.t - r / c);
      const q = s ? s.q : null;
      waveData[i * 4] = q ? q[0] / qmax : 0; waveData[i * 4 + 1] = q ? q[1] / qmax : 0; waveData[i * 4 + 2] = q ? q[2] / qmax : 0; waveData[i * 4 + 3] = q ? q[3] / qmax : 0;
      waveData[(NW + i) * 4] = q ? q[4] / qmax : 0; waveData[(NW + i) * 4 + 1] = q ? q[5] / qmax : 0; waveData[(NW + i) * 4 + 2] = 0; waveData[(NW + i) * 4 + 3] = 0;
    }
    gl.bindTexture(gl.TEXTURE_2D, waveTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NW, 2, gl.RGBA, gl.FLOAT, waveData);
    // masses for the gravity well, relative to the grid centre, weighted by GM/c^2 relative to the largest
    const um = new Float32Array(32); let n = 0, mtot = 0;
    for (const b of sim.bodies) mtot += b.m;
    for (const b of sim.bodies) { if (n >= 8) break; um.set([b.x[0] - cm[0], b.x[1] - cm[1], b.x[2] - cm[2], b.m / mtot * ref], n * 4); n++; }
    gl.depthMask(false);
    // the grid glows at about the brightness of a dark sky, so it never drives the exposure
    pGrid.use().set({ uViewProj: o.viewProj, uFcoef: o.fcoef, uCen: V.sub(cm, camS), uR0: R0, uRmax: Rmax, uAmp: ref * 1.6, uWell: ref * 0.9, uRef: ref, uWave: waveTex, uM: um, uNM: n, uBright: 0.16 * Math.min(1, o.exposure / o.maxExposure) });
    gl.bindVertexArray(gridVAO.vao); gl.drawArrays(gl.LINES, 0, gridCount);
  }
  // gamma ray burst jets: a couple of seconds of relativistic outflow along the spin axis
  for (const b of sb.bodies) {
    const g = b.phys && b.phys.grb; if (!g) continue;
    const age = sb.sim.t - g.t; if (age < 0 || age > 2.5) continue;
    const len = Math.min(c * age, 3e8) + 1e5, I = 4e5 * Math.exp(-age / 0.5);
    const rel = V.sub(b.wpos, camS);
    beam(Object.assign({}, o), rel, g.axis, len, 2e3, len * 0.04, [0.75, 0.85, 1.0], I, 0.6);
    beam(Object.assign({}, o), rel, V.mul(g.axis, -1), len, 2e3, len * 0.04, [0.75, 0.85, 1.0], I, 0.6);
  }
  gl.disable(gl.DEPTH_TEST);
}

// tidal debris: soft glowing blobs with a physical size (the stream is gas, not stars)
const DEB_VS = `layout(location=0) in vec3 aRel; layout(location=1) in vec4 aCol; layout(location=2) in float aSize;
uniform mat4 uViewProj; uniform float uExposure, uPxSA, uPxPerRad; out vec3 vCol; out float vSig;
void main(){
  float d = length(aRel); float I = aCol.a/uPxSA*uExposure;
  float sig = clamp(aSize/d*uPxPerRad, 0.8, 90.);   // point sprites are limited to ~500 px on some GPUs
  vCol = aCol.rgb*min(I/(6.2832*sig*sig), 40.); vSig = sig;
  gl_Position = uViewProj*vec4(aRel, 1.); gl_Position.z = 0.;
  gl_PointSize = I/(6.2832*sig*sig) < 1e-4 ? 0. : ceil(sig*5.);
  if (gl_PointSize == 0.) gl_Position = vec4(2., 2., 2., 1.);
}`;
const DEB_FS = `in vec3 vCol; in float vSig; out vec4 o; void main(){ float sz = ceil(vSig*5.); vec2 d = (gl_PointCoord - 0.5)*sz; o = vec4(vCol*exp(-dot(d, d)/(2.*vSig*vSig)), 1.); }`;
let pDeb, debVAO, debBuf;
export function drawDebris(sb, nav, o) {
  const P = sb.sim.particles;
  // kilonova ejecta: a sphere expanding at ~0.2 c (drawn as one soft blob; inside it, as seen from its edge)
  const blobs = [];
  for (const b of sb.bodies) if (b.knL && b.knR) {
    const rel = V.sub(b.wpos, nav.S), d = Math.max(V.len(rel), b.knR * 1.2), dAU = d / AU, col = bbColor(b.knT), y = 0.2126 * col[0] + 0.7152 * col[1] + 0.0722 * col[2];
    const dir = V.len(rel) > 1 ? V.norm(rel) : Q.rot(nav.q, [0, 0, -1]);
    blobs.push([...V.mul(dir, d), col[0] / y, col[1] / y, col[2] / y, b.knL / (dAU * dAU), b.knR]);
  }
  if ((!P || !P.n) && !blobs.length) return;
  if (!pDeb) {
    pDeb = new Program('debris', DEB_VS, DEB_FS);
    debVAO = gl.createVertexArray(); gl.bindVertexArray(debVAO); debBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, debBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 32, 28); gl.bindVertexArray(null);
  }
  const data = new Float32Array(((P ? P.n : 0) + blobs.length) * 8); let n = 0;
  for (const bl of blobs) data.set(bl, (n++) * 8);
  if (P && P.n) {
  // the stream glows faintly with its own heat; once debris falls back, the flare (up to the Eddington luminosity)
  // is partly absorbed and re-emitted by gas near the hole
  const bh = sb.sim.bodies.find(b => b.id === P.bhId) || P.bh, Lacc = sb.bodies.reduce((s, b) => s + (b.blackHole ? b.lum : 0), 0);
  const age = sb.sim.t - (P.t0 || (P.t0 = sb.sim.t)), Lself = 300 * Math.exp(-age / (3 * DAY)) + 2;
  const rr = new Float32Array(P.n); let near = 0;
  for (let i = 0; i < P.n; i++) { const x = P.x[i * 3]; if (x !== x) { rr[i] = -1; continue; } rr[i] = Math.hypot(x - bh.x[0], P.x[i * 3 + 1] - bh.x[1], P.x[i * 3 + 2] - bh.x[2]); if (rr[i] < 20 * AU) near++; }
  // the gas expands as it travels: blob size grows with time since the disruption (sound speed ~ few km/s)
  const size = Math.max(7e8, 2e3 * age);
  for (let i = 0; i < P.n; i++) {
    if (rr[i] < 0) continue;
    const rel = [P.x[i * 3] - nav.S[0], P.x[i * 3 + 1] - nav.S[1], P.x[i * 3 + 2] - nav.S[2]];
    const dAU = Math.hypot(...rel) / AU;
    const hot = rr[i] < 20 * AU && Lacc > 1e3, rep = hot && near ? 0.1 * Lacc / near * Math.min(1, (2 * AU / Math.max(rr[i], AU * 0.05)) ** 2) : 0;
    const L = Lself / P.n + rep, col = hot ? [0.72, 0.84, 1.0] : [1.0, 0.62, 0.42];
    data.set([rel[0], rel[1], rel[2], col[0], col[1], col[2], L / (dAU * dAU), size], n * 8); n++;
  }
  }
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.DEPTH_TEST);
  gl.bindVertexArray(debVAO); gl.bindBuffer(gl.ARRAY_BUFFER, debBuf); gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * 8), gl.DYNAMIC_DRAW);
  pDeb.use().set({ uViewProj: o.viewProj, uExposure: o.exposure, uPxSA: o.pxSA, uPxPerRad: o.pxPerRad });
  gl.drawArrays(gl.POINTS, 0, n);
}

// kilonova glow as a point
export function sandboxPoints(sb, nav) {
  const pts = [];

  return pts;
}
