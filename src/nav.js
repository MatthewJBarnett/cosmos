// Camera and world state: hierarchical position (universe / galaxy / star system), movement, go-to,
// object following, level transitions and picking.
import { V, Q, C, clamp } from './math.js';
import { gl, makeVAO } from './gl.js';
import { MILKY_WAY, REAL_GALAXIES, galaxyName, SUN_POS, galDir } from './universe.js';
import { visibleNebulae, REAL_NEBULAE } from './exotic.js';
import { catalog, loadCatalog, bodyMaps } from './assets.js';
import { EXTRA_STARS, extraStarPos } from './realsystems.js';
import { starFromCatalog } from './stars.js';
import { StarField, sunDescriptor } from './starfield.js';
import { StarSystem, starName } from './system.js';
import { planetState } from './planet.js';
import { descPosP, updateWorld, YEAR } from './galdyn.js';
import { visibleGalaxyCells } from './sky.js';

const PC = C.PC, MPC = C.PC * 1e6;
const fields = new Map(), systems = new Map();

function hashStrLocal(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function addFixed(f, desc, MV, T) {
  const data = new Float32Array([0, 0, 0, MV, T]);
  const cell = { fixedCell: true, origin: desc.pos.slice(), n: 1, data, last: Infinity, vao: makeVAO([{ data, stride: 20, parts: [{ loc: 0, size: 3, offset: 0 }, { loc: 1, size: 2, offset: 12 }] }]) };
  f.fixed.push({ pos: desc.pos.slice(), MV, desc, cell });
  f.cells.set('fixed:' + desc.key, cell);
}
function fieldFor(g) {
  let f = fields.get(g.id);
  if (f) return f;
  f = new StarField(g);
  if (g === MILKY_WAY) {
    addFixed(f, sunDescriptor(g), 4.83, 5772);
    for (const e of EXTRA_STARS) {
      const st = starFromCatalog(e[4], e[5], e[6]); st.mass = e[7] * C.Msun; st.radius = e[8] * C.Rsun; st.lum = 4 * Math.PI * st.radius ** 2 * C.sigma * Math.pow(e[5], 4) / C.Lsun;
      addFixed(f, { galaxy: g, seed: (hashStrLocal(e[0]) ^ 0x7e) >>> 0, pos: extraStarPos(e), motion: { type: 'cat', prel: V.mul(galDir(e[1], e[2]), e[3]), vel: e[9] }, key: g.id + '/x:' + e[0], name: e[0], star: st }, e[4], e[5]);
    }
    // real stars around the Sun (HYG catalogue); procedural stars are suppressed where it is complete
    f.catalogCenter = SUN_POS;
    loadCatalog().then(() => {
      if (!catalog.ready) return;
      f.cells.set('catalog', { fixedCell: true, catalog: true, origin: SUN_POS, n: catalog.count, data: catalog.data, vel: catalog.vel, last: Infinity,
        vao: makeVAO([{ data: catalog.data, stride: 20, parts: [{ loc: 0, size: 3, offset: 0 }, { loc: 1, size: 2, offset: 12 }] }, { data: catalog.vel, stride: 16, parts: [{ loc: 2, size: 4, offset: 0 }] }]) });
    });
    // Cygnus X-1: stellar black hole with a blue supergiant companion
    const d = galDir(71.33, 3.07);
    addFixed(f, { galaxy: g, seed: 0xc791, pos: V.addm(SUN_POS, d, 2200), motion: { type: 'circ' }, key: g.id + '/cygx1', name: 'Cygnus X-1', star: { kind: 5, MV: 12, T: 0, mass: 21 * C.Msun, radius: 2 * C.G * 21 * C.Msun / (C.c * C.c), lum: 0, cls: 'Black hole', accretion: 1 }, companion: { MV: -6.5, u1: 0.2, u2: 0.4, sep: 0.2 } }, -6.5, 30000);
    // the Crab Pulsar, inside the Crab Nebula (2 kpc): a 33 ms neutron star
    { const dc = galDir(184.56, -5.78), R = 12e3, T = 1.6e6;
      addFixed(f, { galaxy: g, seed: 0xc4ab, pos: V.addm(SUN_POS, dc, 2000), motion: { type: 'circ' }, key: g.id + '/crabpsr', name: 'Crab Pulsar',
        star: { kind: 4, MV: 16.5, T, mass: 1.4 * C.Msun, radius: R, lum: 4 * Math.PI * R * R * C.sigma * T ** 4 / C.Lsun, cls: 'Neutron star (pulsar)', period: 0.0337 } }, 16.5, 30000); }
  }
  // central supermassive black hole
  {
    const mass = (g === MILKY_WAY ? 4.3e6 : Math.max(1e5, g.mass * 2e-4 * (g.bulge || 1) / 5)) * C.Msun;
    const desc = { galaxy: g, seed: (g.seed ^ 0x5b1) >>> 0, pos: [0, 0, 0], key: g.id + '/smbh', name: g === MILKY_WAY ? 'Sagittarius A*' : galaxyName(g) + ' central black hole',
      star: { kind: 5, MV: 9, T: 0, mass, radius: 2 * C.G * mass / (C.c * C.c), lum: 0, cls: 'Supermassive black hole', accretion: 0.8 } };
    addFixed(f, desc, 9, 6000);
  }
  fields.set(g.id, f);
  if (fields.size > 3) { const k = fields.keys().next().value; fields.get(k).dispose(); fields.delete(k); }
  return f;
}
export function systemFor(desc) {
  let s = systems.get(desc.key);
  if (s) return s;
  s = new StarSystem(desc);
  systems.set(desc.key, s);
  if (systems.size > 8) systems.delete(systems.keys().next().value);
  return s;
}
export const solSystem = () => systemFor(sunDescriptor(MILKY_WAY));

export function targetName(t) {
  if (!t) return '';
  if (t.type === 'body') return t.body.name;
  if (t.type === 'star') return starName(t.desc);
  if (t.type === 'nebula') return t.neb.name;
  return galaxyName(t.galaxy);
}

export class Nav {
  constructor() {
    this.fov = 55 * Math.PI / 180;
    this.q = Q.ident(); this.level = 'system';
    this.U = [0, 0, 0]; this.G = [0, 0, 0]; this.S = [0, 0, 0];
    this.galaxy = MILKY_WAY; this.field = fieldFor(MILKY_WAY);
    this.system = solSystem();
    this.time = (Date.now() - Date.UTC(2000, 0, 1, 12)) / 1000; this.rate = 1; this.paused = false;
    updateWorld(this.time);
    this.speed = 5e6; this.vel = [0, 0, 0]; this.selected = null; this.goto = null; this.anchor = null;
    this.frame = 0; this.altitude = 1e30; this.speedNow = 0; this.onArrive = null;
    this.system.update(this.time);
    const earth = this.system.find('Earth'), sun = this.system.find('Sun');
    const toSun = V.norm(V.sub(sun.wpos, earth.wpos));
    const side = V.norm(V.cross(toSun, [0.2, 1, 0.1]));
    const off = V.norm(V.add(V.mul(toSun, 0.55), V.add(V.mul(side, 0.8), [0, 0.25, 0])));
    this.S = V.add(earth.wpos, V.mul(off, earth.radius * 3.4));
    this.q = Q.look(V.mul(off, -1), [0, 1, 0]);
    this.selected = { type: 'body', body: earth };
  }
  // ----- positions at each scale -----
  camG() { return this.level === 'system' ? V.addm(this.system.posGu, this.S, 1 / PC) : this.level === 'galaxy' ? this.G : null; }
  camU() { if (this.level === 'universe') return this.U; const g = this.camG(); return V.addm(this.galaxy.posU, g, 1e-6); }
  camLocal() { return Q.rot(Q.conj(this.galaxy.quat), this.camG()); }
  // vector (metres, universe axes) from camera to a point given in a galaxy (pc, universe axes) plus metres offset
  relGalactic(g, posGu, extraM) {
    let r;
    if (this.galaxy === g && this.level === 'system') { const sp = this.system.posGu; r = [(posGu[0] - sp[0]) * PC - this.S[0], (posGu[1] - sp[1]) * PC - this.S[1], (posGu[2] - sp[2]) * PC - this.S[2]]; }
    else if (this.galaxy === g && this.level === 'galaxy') r = [(posGu[0] - this.G[0]) * PC, (posGu[1] - this.G[1]) * PC, (posGu[2] - this.G[2]) * PC];
    else { const cu = this.camU(); r = [((g.posU[0] - cu[0]) * 1e6 + posGu[0]) * PC, ((g.posU[1] - cu[1]) * 1e6 + posGu[1]) * PC, ((g.posU[2] - cu[2]) * 1e6 + posGu[2]) * PC]; }
    return extraM ? V.add(r, extraM) : r;
  }
  relTo(t) {
    if (t.type === 'dir') return V.mul(t.dir, 1e20);
    if (t.type === 'body') {
      const b = t.body, sys = b.system;
      let r;
      if (sys === this.system && this.level === 'system') r = V.sub(b.wpos, this.S);
      else { if (sys.time !== this.time) sys.update(this.time); r = this.relGalactic(sys.galaxy, sys.posGu, b.wpos); }
      if (t.offset) r = V.add(r, t.offset);
      return r;
    }
    if (t.type === 'star') { const g = t.desc.galaxy; return this.relGalactic(g, Q.rot(g.quat, descPosP(t.desc))); }
    if (t.type === 'nebula') return this.relGalactic(t.galaxy, Q.rot(t.galaxy.quat, t.neb.pos));
    const cu = this.camU(), g = t.galaxy;
    return [(g.posU[0] - cu[0]) * MPC, (g.posU[1] - cu[1]) * MPC, (g.posU[2] - cu[2]) * MPC];
  }
  targetRadius(t) { return t.type === 'body' ? (t.body.radius || 1e9) : t.type === 'star' ? t.desc.star.radius : t.type === 'nebula' ? t.neb.radius * PC : t.galaxy.radius * PC; }

  move(dm) {
    if (this.level === 'system') this.S = V.add(this.S, dm);
    else if (this.level === 'galaxy') this.G = V.addm(this.G, dm, 1 / PC);
    else this.U = V.addm(this.U, dm, 1 / MPC);
  }

  // ----- level transitions -----
  enterSystem(desc) {
    const sys = systemFor(desc);
    const g = this.camG();
    this.S = [(g[0] - sys.posGu[0]) * PC, (g[1] - sys.posGu[1]) * PC, (g[2] - sys.posGu[2]) * PC];
    this.system = sys; this.level = 'system'; sys.update(this.time);
    // a go-to aimed at the star continues towards its body
    if (this.goto && this.goto.target.type === 'star' && this.goto.target.desc.key === desc.key) this.retarget({ type: 'body', body: sys.stars[0] });
    if (this.selected && this.selected.type === 'star' && this.selected.desc.key === desc.key) this.selected = { type: 'body', body: sys.stars[0] };
  }
  retarget(t) {
    const g = this.goto; g.target = t;
    const d = V.len(this.relTo(t)); g.d0 = d / Math.pow(d / g.d1n(t), g.e); g.d1 = g.d1n(t);
  }
  transitions() {
    this.frame++;
    if (this.level === 'system') {
      if (V.len(this.S) > 0.25 * PC) { this.G = this.camG(); this.level = 'galaxy'; this.system = null; this.anchor = null; }
    } else if (this.level === 'galaxy') {
      if (this.frame % 10 === 0 || this.goto) {
        const n = this.field.nearest(this.camLocal(), 0.2);
        if (n) { this.enterSystem(n); return; }
      }
      if (V.len(this.G) > 4 * this.galaxy.radius) { this.U = this.camU(); this.level = 'universe'; this.galaxy = null; this.field = null; }
    } else if (this.frame % 10 === 0 || this.goto) {
      let best = null, bs = 3.5;
      const test = (g) => { const d = V.dist(g.posU, this.U) * 1e6 / g.radius; if (d < bs) { bs = d; best = g; } };
      for (const c of visibleGalaxyCells) for (const g of c.list) test(g);
      if (best) { this.galaxy = best; this.field = fieldFor(best); this.G = [(this.U[0] - best.posU[0]) * 1e6, (this.U[1] - best.posU[1]) * 1e6, (this.U[2] - best.posU[2]) * 1e6]; this.level = 'galaxy'; }
    }
  }

  // enter a system that is not in the star field (the physics sandbox)
  enterCustomSystem(sys, camS, q) {
    this.galaxy = sys.galaxy; this.field = fieldFor(sys.galaxy); this.system = sys; this.level = 'system';
    this.S = camS; if (q) this.q = q; this.goto = null; this.anchor = null; this.orbit = null; this.selected = null; this.lookTarget = null; this.vel = [0, 0, 0];
    sys.navT = undefined; sys.update(this.time);
  }
  // ----- go-to -----
  goTo(t, opt = {}) {
    if (!t) return;
    const d1n = (tt) => opt.dist || (tt.type === 'body' ? tt.body.radius * (tt.body.kind === 'star' ? (tt.body.blackHole ? 40 : 7) : tt.body.rings ? 5.5 : 3.3) || 1e10 : tt.type === 'star' ? tt.desc.star.radius * 7 + 1e7 : tt.type === 'nebula' ? tt.neb.radius * PC * 2.6 : tt.galaxy.radius * PC * 2.3);
    const d = V.len(this.relTo(t));
    const d1 = d1n(t);
    const dur = opt.dur || clamp(2.5 + Math.abs(Math.log10(d / d1)) * 0.75, 2.5, 11);
    this.goto = { target: t, t: 0, dur, d0: d, d1, d1n, e: 0, land: opt.land };
    this.selected = t.offset ? { type: 'body', body: t.body } : t;
  }
  land(body, opt = {}) {
    if (!body || !body.surface) return;
    // real elevation data must be loaded before we can pick a landing height
    if (body.maps && !opt.noWait && (!bodyMaps(body) || body.maps._state.preview)) {
      this.pendingLand = { body, opt, t: 0 }; this.selected = { type: 'body', body }; return;
    }
    const sys = body.system; const rel = this.relTo({ type: 'body', body });
    const toCam = V.norm(V.mul(rel, -1));
    let dir = toCam;
    if (opt.sunAngle !== undefined && sys.stars.length) { const toStar = V.norm(V.sub(sys.stars[0].wpos, body.wpos)); const perp = V.norm(V.cross(toStar, V.cross(toCam, toStar))); dir = V.norm(V.add(V.mul(toStar, Math.cos(opt.sunAngle)), V.mul(perp, Math.sin(opt.sunAngle)))); }
    else if (sys.stars.length && body.kind !== 'star') { const toStar = V.norm(V.sub(sys.stars[0].wpos, body.wpos)); dir = V.norm(V.add(V.mul(toCam, 0.6), toStar)); if (V.dot(dir, toStar) < 0.25) dir = V.norm(V.add(dir, V.mul(toStar, 0.6))); }
    let h = 0;
    if (body.surface.gen === 'terra') {
      const st = planetState(body), inv = Q.conj(body.wrot), sea = body.surface.ocean > 0.5 ? body.surface.sea : -1e9;
      h = st.queryHeight(Q.rot(inv, dir));
      if (opt.dir) { dir = V.norm(opt.dir); h = st.queryHeight(Q.rot(inv, dir)); }
      else if (opt.prefer === 'high') {
        const a = V.norm(V.cross(dir, [0.31, 0.77, 0.55])), b2 = V.cross(dir, a);
        for (let ring = 1; ring <= 7; ring++) for (let k = 0; k < 10; k++) {
          const ang = ring * 0.05, az = k / 10 * 6.2832 + ring;
          const d2 = V.norm(V.add(V.mul(dir, Math.cos(ang)), V.add(V.mul(a, Math.sin(ang) * Math.cos(az)), V.mul(b2, Math.sin(ang) * Math.sin(az)))));
          const h2 = st.queryHeight(Q.rot(inv, d2));
          if (h2 > h) { dir = d2; h = h2; }
        }
      }
      else if (h <= sea + 20) {
        // prefer dry land: probe nearby directions
        let a = V.norm(V.cross(dir, [0.31, 0.77, 0.55])), b2 = V.cross(dir, a);
        search: for (let ring = 1; ring <= 6; ring++) for (let k = 0; k < 10; k++) {
          const ang = ring * 0.09, az = k / 10 * 6.2832 + ring;
          const d2 = V.norm(V.add(V.mul(dir, Math.cos(ang)), V.add(V.mul(a, Math.sin(ang) * Math.cos(az)), V.mul(b2, Math.sin(ang) * Math.sin(az)))));
          const h2 = st.queryHeight(Q.rot(inv, d2));
          if (h2 > sea + 60) { dir = d2; h = h2; break search; }
        }
      }
    }
    const off = V.mul(dir, body.radius + h + (body.surface.gen === 'terra' ? 1200 : body.radius * 0.02));
    this.goTo({ type: 'body', body, offset: off }, Object.assign({ dist: 1, land: { dir } }, opt));
  }
  // shift time (by less than one rotation) so that it is `hour` local solar time at longitude lon on body
  setLocalTime(body, lon, hour) {
    const sys = body.system, star = sys.stars[0]; if (!star || !body.rotPeriod) return;
    sys.update(this.time);
    const d = Q.rot(Q.conj(body.wrot), V.norm(V.sub(star.wpos, body.wpos)));
    const subLon = Math.atan2(-d[2], d[0]) * 180 / Math.PI;
    let want = lon - (hour - 12) * 15;                 // sub-solar longitude needed
    let delta = ((subLon - want) % 360 + 540) % 360 - 180;
    // rotating eastward moves the sub-solar point west
    this.time += delta / 360 * Math.abs(body.rotPeriod) * Math.sign(body.rotPeriod);
    sys.update(this.time);
  }
  // land at a planetographic latitude/longitude (degrees)
  landAt(body, lat, lon, opt = {}) {
    if (opt.hour !== undefined) this.setLocalTime(body, lon, opt.hour);
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    const dirL = [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)];
    body.system.update(this.time);
    this.land(body, Object.assign({ dir: Q.rot(body.wrot, dirL), dir0: dirL }, opt));
  }
  stepGoto(dt) {
    const g = this.goto; if (!g) return;
    g.t += dt; const x = clamp(g.t / g.dur, 0, 1);
    const e = x * x * x * (x * (x * 6 - 15) + 10); g.e = e;
    const rel = this.relTo(g.target), dist = V.len(rel);
    const want = Math.exp(Math.log(g.d0) + (Math.log(g.d1) - Math.log(g.d0)) * e);
    const dir = V.mul(rel, 1 / dist);
    this.move(V.mul(dir, dist - want));
    this.speedNow = Math.abs(dist - want) / Math.max(dt, 1e-6);
    // turn towards the target
    if (!g.land || x < 0.75) {
      const up = Q.rot(this.q, [0, 1, 0]);
      const tq = Q.look(g.target.offset ? V.sub(rel, V.mul(g.target.offset, 0.999)) : rel, up);
      this.q = Q.slerp(this.q, tq, g.dur < 0.1 ? 1 : 1 - Math.exp(-dt * 4));
    } else {
      // level out for landing: look along the horizon towards the sun
      const upv = g.land.dir, b = g.target.body, st = b.system.stars[0];
      let f = st ? V.sub(st.wpos, b.wpos) : Q.rot(this.q, [0, 0, -1]);
      f = V.norm(V.sub(f, V.mul(upv, V.dot(f, upv))));
      // look across the light (sun about 70 degrees to the left), the most readable lighting for terrain
      const side = V.cross(upv, f); f = V.norm(V.add(V.mul(f, 0.34), V.mul(side, -0.94)));
      f = V.norm(V.add(f, V.mul(upv, -0.06)));
      this.q = Q.slerp(this.q, Q.look(f, upv), g.dur < 0.1 ? 1 : 1 - Math.exp(-dt * 3));
    }
    if (x >= 1) {
      this.goto = null;
      this.speed = clamp(want * 0.4, 20, 1e25);
      if (this.onArrive) { const f = this.onArrive; this.onArrive = null; f(); }
    }
  }

  // ----- orbital flight: Newtonian two-body motion around the anchor body -----
  enterOrbit() {
    const b = this.anchor; if (!b || this.level !== 'system' || !b.mass) return false;
    const r = V.sub(this.S, b.wpos), rl = V.len(r), up = V.mul(r, 1 / rl);
    let f = Q.rot(this.q, [0, 0, -1]); f = V.sub(f, V.mul(up, V.dot(f, up)));
    if (V.len(f) < 1e-6) f = V.cross(up, [0, 1, 0]);
    f = V.norm(f);
    const v = Math.sqrt(C.G * b.mass / rl);
    this.orbit = { body: b, v: V.mul(f, v) };      // velocity relative to the body, in the inertial (non-rotating) frame
    this.goto = null;
    return true;
  }
  stepOrbit(dt, input) {
    const o = this.orbit, b = o.body, GM = C.G * b.mass;
    // thrust from the movement keys (camera axes), ~1% of orbital speed per second
    const vl = V.len(o.v), th = vl * 0.01 * (input.fast ? 10 : 1) * (input.slow ? 0.1 : 1);
    if (input.mx || input.my || input.mz) o.v = V.add(o.v, Q.rot(this.q, V.mul([input.mx, input.my, input.mz], th * dt)));
    // integrate in simulation time (leapfrog, substeps), relative to the body; the anchor follow keeps us with it
    let T = this.paused ? 0 : dt * this.rate;
    let r = V.sub(this.S, b.wpos);
    const n = Math.min(400, Math.max(1, Math.ceil(Math.abs(T) / Math.max(1, 0.002 * 2 * Math.PI * Math.sqrt(V.len(r) ** 3 / GM)))));
    const h = T / n;
    for (let i = 0; i < n; i++) {
      let rl = V.len(r); o.v = V.addm(o.v, r, -GM / (rl * rl * rl) * h * 0.5);
      r = V.addm(r, o.v, h);
      rl = V.len(r); o.v = V.addm(o.v, r, -GM / (rl * rl * rl) * h * 0.5);
    }
    // undo the co-rotation applied by the anchor follow: orbits are inertial
    this.S = V.add(b.wpos, r);
    // orbital elements for the HUD
    const rl = V.len(r), v2 = V.dot(o.v, o.v), eps = v2 / 2 - GM / rl, a = -GM / (2 * eps);
    const hv = V.cross(r, o.v), e = Math.sqrt(Math.max(0, 1 + 2 * eps * V.dot(hv, hv) / (GM * GM)));
    o.peri = a * (1 - e) - b.radius; o.apo = eps < 0 ? a * (1 + e) - b.radius : Infinity; o.period = eps < 0 ? 2 * Math.PI * Math.sqrt(a * a * a / GM) : Infinity; o.speed = Math.sqrt(v2);
    this.speedNow = o.speed;
    if (rl < b.radius + (b._groundH || 0) + 50) { this.orbit = null; this.vel = [0, 0, 0]; }
  }

  // ----- per frame -----
  update(dt, input) {
    if (!this.paused) this.time += dt * this.rate;
    updateWorld(this.time, this.paused ? 0 : dt * this.rate / YEAR);
    if (this.pendingLand) { const p = this.pendingLand; p.t += dt; const ms = bodyMaps(p.body); if ((ms && !ms.preview) || p.t > 30) { this.pendingLand = null; if (p.opt.dir0) p.opt.dir = Q.rot(p.body.wrot, p.opt.dir0); this.land(p.body, Object.assign({}, p.opt, { noWait: true })); } }
    // start loading surface maps of the selection early
    if (this.selected && this.selected.type === 'body' && this.selected.body.maps) bodyMaps(this.selected.body);
    const sys = this.system;
    // follow the anchor body through its orbital motion and rotation
    let anchor = null;
    if (sys && this.level === 'system') {
      const prev = this.anchor && this.anchor.system === sys ? this.anchor : null;
      const prevPos = prev ? prev.wpos : null, prevAng = prev ? prev.rotAngle : 0;
      sys.update(this.time);
      if (prev) {
        this.S = V.add(this.S, V.sub(prev.wpos, prevPos));
        const rel = V.sub(this.S, prev.wpos), alt = V.len(rel) - prev.radius;
        const w = prev.kind === 'star' || this.orbit ? 0 : clamp((1.2 * prev.radius - alt) / (1.0 * prev.radius), 0, 1);
        if (w > 0 && prev.rotPeriod && !this.paused) {
          const dAng = 2 * Math.PI * dt * this.rate / prev.rotPeriod * w;
          const axis = Q.rot(prev.wrot, [0, 1, 0]), rq = Q.axis(axis, dAng);
          this.S = V.add(prev.wpos, Q.rot(rq, rel)); this.q = Q.norm(Q.mul(rq, this.q));
        }
      }
      // choose anchor for the next frame
      let best = 30;
      for (const b of sys.bodies) {
        if (!b.radius) continue;
        // ringed planets keep you anchored out to the edge of their rings
        const reach = b.rings ? Math.max(30, b.rings.outer / b.radius * 1.5) : 30;
        const d = V.dist(b.wpos, this.S) / b.radius / (reach / 30);
        if (d < best) { best = d; anchor = b; }
      }
      if (!anchor && this.selected && this.selected.type === 'body' && this.selected.body.system === sys && !this.goto) { const b = this.selected.body; if (b.radius && V.dist(b.wpos, this.S) < b.radius * 3000) anchor = b; }
      if (this.goto && this.goto.target.type === 'body' && this.goto.target.body.system === sys) anchor = this.goto.target.body;
    }
    this.anchor = anchor;
    let alt = 1e30, up = null;
    if (anchor) { const rel = V.sub(this.S, anchor.wpos); const d = V.len(rel); alt = d - anchor.radius - (anchor._groundH || 0); up = V.mul(rel, 1 / d); }

    // look
    const ls = this.fov / 900;
    if (input.lookX || input.lookY) {
      const nearGround = up && alt < anchor.radius * 0.15;
      if (nearGround) this.q = Q.mul(Q.axis(up, -input.lookX * ls), this.q); else this.q = Q.mul(this.q, Q.axis([0, 1, 0], -input.lookX * ls));
      this.q = Q.mul(this.q, Q.axis([1, 0, 0], -input.lookY * ls));
    }
    if (input.roll) this.q = Q.mul(this.q, Q.axis([0, 0, 1], input.roll * dt * 1.2));
    if (input.turnX || input.turnY) { this.q = Q.mul(this.q, Q.axis([0, 1, 0], -input.turnX * dt * 0.9)); this.q = Q.mul(this.q, Q.axis([1, 0, 0], -input.turnY * dt * 0.9)); }
    // keep the horizon level near the ground unless rolling
    if (up && alt < anchor.radius * 0.05 && !input.roll && !this.goto) {
      const r = Q.rot(this.q, [1, 0, 0]), f = Q.rot(this.q, [0, 0, -1]);
      if (Math.abs(V.dot(f, up)) < 0.95) { const rollErr = Math.asin(clamp(V.dot(r, up), -1, 1)); this.q = Q.mul(this.q, Q.axis([0, 0, 1], -rollErr * Math.min(1, dt * 3))); }
    }
    // turn to face a target (C key)
    if (this.lookTarget) {
      const rel = this.relTo(this.lookTarget), tq = Q.look(rel, Q.rot(this.q, [0, 1, 0]));
      this.q = Q.slerp(this.q, tq, 1 - Math.exp(-dt * 6));
      if (V.dot(Q.rot(this.q, [0, 0, -1]), V.norm(rel)) > 0.99999 || input.lookX || input.lookY) this.lookTarget = null;
    }
    this.q = Q.norm(this.q);
    // orbit around the selection
    if ((input.orbitX || input.orbitY) && this.selected && !this.goto) {
      const rel = this.relTo(this.selected);
      const upW = Q.rot(this.q, [0, 1, 0]), rightW = Q.rot(this.q, [1, 0, 0]);
      const R = Q.mul(Q.axis(upW, -input.orbitX * 0.005), Q.axis(rightW, -input.orbitY * 0.005));
      const camRel = V.mul(rel, -1), nr = Q.rot(R, camRel);
      this.move(V.sub(nr, camRel)); this.q = Q.norm(Q.mul(R, this.q));
    }
    if (input.zoom && this.selected && !this.goto) {
      const rel = this.relTo(this.selected), d = V.len(rel), R = this.targetRadius(this.selected);
      const nd = Math.max(R * 1.0005, (d - R) * Math.pow(1.0015, input.zoom) + R);
      this.move(V.mul(rel, (d - nd) / d));
    }
    if (input.wheel) this.speed = clamp(this.speed * Math.pow(1.0018, -input.wheel), 0.5, 3e25);

    // translate
    if (this.orbit && (this.goto || !anchor || anchor !== this.orbit.body || this.level !== 'system')) this.orbit = null;
    if (this.orbit) { this.stepOrbit(dt, input); }
    else if (this.goto) { this.stepGoto(dt); this.vel = [0, 0, 0]; }
    else {
      let sp = this.speed * (input.fast ? 10 : 1) * (input.slow ? 0.1 : 1);
      if (anchor && alt < anchor.radius * 4) sp = Math.min(sp, Math.max(alt * 1.5, 3) * (input.fast ? 4 : 1));
      const want = V.mul([input.mx, input.my, input.mz], sp);
      const k = 1 - Math.exp(-dt * 7);
      this.vel = V.lerp(this.vel, want, k);
      this.speedNow = V.len(this.vel);
      if (this.speedNow > 0) this.move(Q.rot(this.q, V.mul(this.vel, dt)));
    }

    // terrain collision
    this.altitude = 1e30;
    if (anchor && this.level === 'system') {
      const rel = V.sub(this.S, anchor.wpos); let d = V.len(rel);
      let h = 0;
      if (anchor.surface && anchor.surface.gen === 'terra' && d - anchor.radius < Math.max(anchor.radius * 0.02, (anchor.surface.hmax || 0) * 3 + 3000)) {
        const st = planetState(anchor), dirL = Q.rot(Q.conj(anchor.wrot), V.mul(rel, 1 / d));
        if (this.sync) h = st.queryHeight(dirL);
        else { const r = st.queryHeightAsync(dirL); h = r === null ? (anchor._groundH || 0) : r; }
        st.groundH = h;
      } else if (anchor.surface) planetState(anchor).groundH = 0;
      anchor._groundH = h;
      // radius of the (possibly triaxial) surface under the camera
      let Rs = anchor.radius;
      if (anchor.shape) { const dl = Q.rot(Q.conj(anchor.wrot), V.mul(rel, 1 / d)), sh = anchor.shape; Rs = anchor.radius / Math.hypot(dl[0] / sh[0], dl[1] / sh[1], dl[2] / sh[2]); }
      const minR = anchor.kind === 'star' ? anchor.radius * 1.02 : Rs + h * (Rs / anchor.radius) + (anchor.surface && anchor.surface.gen === 'terra' ? 1.7 : anchor.radius * 0.001);
      if (d < minR) { this.S = V.add(anchor.wpos, V.mul(rel, minR / d)); d = minR; }
      this.altitude = d - anchor.radius - h;
    }
    if (this.field) this.field.updateFixed();
    this.transitions();
    if (this.field && this.level !== 'universe') this.field.update(this.camLocal(), this.sync ? 400 : 5);
  }

  // ----- picking: ray direction in world axes, pixel angular size -----
  pick(dir, pxRad) {
    if (this.system && this.level === 'system') {
      let best = null, bs = 1e9;
      for (const b of this.system.bodies) {
        if (b.kind === 'barycenter') continue;
        const rel = V.sub(b.wpos, this.S), d = V.len(rel);
        const sep = Math.acos(clamp(V.dot(rel, dir) / d, -1, 1)), ar = Math.asin(Math.min(1, b.radius / d));
        const thr = Math.max(ar, 11 * pxRad);
        if (sep > thr) continue;
        const score = sep < ar ? d * 1e-30 : sep / thr + (b.kind === 'moon' ? 0.2 : 0);
        if (score < bs) { bs = score; best = b; }
      }
      if (best) return { type: 'body', body: best };
    }
    if (this.galaxy && this.level !== 'universe') {
      for (const v of visibleNebulae) { const sep = Math.acos(clamp(V.dot(v.rel, dir) / v.d, -1, 1)); if (v.d > v.nb.radius && sep < Math.atan(v.nb.radius / v.d) * 0.6 && v.px > 12) return { type: 'nebula', neb: v.nb, galaxy: this.galaxy }; }
    }
    if (this.field && this.level !== 'universe') {
      const s = this.field.pick(this.camLocal(), Q.rot(Q.conj(this.galaxy.quat), dir), 9 * pxRad);
      if (s && !(this.system && s.key === this.system.desc.key)) return { type: 'star', desc: s };
    }
    const cu = this.camU(); let best = null, bs = 1e9;
    const test = (g) => {
      if (g === this.galaxy && V.len(this.camG()) < g.radius * 1.2) return;
      const rel = V.sub(g.posU, cu), d = V.len(rel); if (d <= 0) return;
      const sep = Math.acos(clamp(V.dot(rel, dir) / d, -1, 1)), ar = g.radius * 1e-6 / d;
      if (ar < 1.2 * pxRad) return;
      const thr = Math.max(ar * 0.7, 8 * pxRad); if (sep > thr) return;
      const score = sep / thr - Math.log10(ar) * 0.2; if (score < bs) { bs = score; best = g; }
    };
    for (const c of visibleGalaxyCells) for (const g of c.list) test(g);
    return best ? { type: 'galaxy', galaxy: best } : null;
  }

  // serialise / restore a location (for URLs and testing)
  describe() { return { level: this.level, dist: this.selected ? V.len(this.relTo(this.selected)) : 0 }; }
}

export function findByName(nav, name) {
  const n = name.trim().toLowerCase(); if (!n) return null;
  if (nav.system) { const b = nav.system.bodies.find(b => b.name.toLowerCase() === n) || nav.system.bodies.find(b => b.name.toLowerCase().startsWith(n)); if (b) return { type: 'body', body: b }; }
  const sol = solSystem(); const b = sol.bodies.find(b => b.name.toLowerCase() === n) || (n.length > 2 && sol.bodies.find(b => b.name.toLowerCase().startsWith(n)));
  if (b) return { type: 'body', body: b };
  if (catalog.ready) {
    const cf = fieldFor(MILKY_WAY), cell = cf.cells.get('catalog');
    const hit = catalog.named.find(x => x.name.toLowerCase() === n) || catalog.named.find(x => x.desig && x.desig.toLowerCase() === n) || (n.length > 2 && catalog.named.find(x => x.name.toLowerCase().startsWith(n)));
    if (hit && cell) return { type: 'star', desc: cf.starAt(cell, hit.i) };
  }
  const mwf = fieldFor(MILKY_WAY).fixed.find(f => f.desc.name && f.desc.name.toLowerCase().includes(n));
  if (mwf) return { type: 'star', desc: mwf.desc };
  const nb = REAL_NEBULAE.find(x => x.name.toLowerCase().includes(n));
  if (nb) return { type: 'nebula', neb: nb, galaxy: MILKY_WAY };
  const g = REAL_GALAXIES.find(g => g.name.toLowerCase().includes(n));
  if (g) return { type: 'galaxy', galaxy: g };
  return null;
}
export function searchList(nav) {
  const out = [];
  if (nav.system) for (const b of nav.system.bodies) if (b.kind !== 'barycenter') out.push(b.name);
  for (const b of solSystem().bodies) if (!out.includes(b.name)) out.push(b.name);
  for (const g of REAL_GALAXIES) out.push(g.name);
  for (const x of REAL_NEBULAE) out.push(x.name);
  out.push('Sagittarius A*', 'Cygnus X-1', 'Crab Pulsar', 'Proxima Centauri', 'TRAPPIST-1', "Barnard's Star");
  if (catalog.ready) for (const x of catalog.named) if (!/^HIP /.test(x.name)) out.push(x.name);
  return out;
}
