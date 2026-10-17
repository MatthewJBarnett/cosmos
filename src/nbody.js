// Gravitational N-body dynamics for the sandbox, in SI units.
// Newtonian gravity between all bodies plus, for every pair, the post-Newtonian relative acceleration at 1PN
// (perihelion precession, ISCO-like behaviour) and 2.5PN (radiation reaction: orbits shrink as they emit
// gravitational waves, reproducing the Peters formula). Mergers of black holes use fits to numerical relativity
// for the radiated energy, final spin, recoil kick and ringdown. Strain is computed from the mass quadrupole.
import { C } from './math.js';

const G = C.G, c = C.c, c2 = c * c, c5 = c2 * c2 * c;
export const MSUN = C.Msun;

let nextId = 1;
export function makeBody(kind, m, x, v, extra = {}) {
  const b = Object.assign({ id: nextId++, kind, m, x: x.slice(), v: v.slice(), R: 0, chi: 0, name: '', alive: true }, extra);
  if (!b.R) b.R = radiusFor(kind, m);
  return b;
}
// sizes: Schwarzschild radius for black holes, ~12 km neutron stars, main sequence stars, rocky planets
export function radiusFor(kind, m) {
  if (kind === 'bh') return 2 * G * m / c2;
  if (kind === 'ns') return 12e3;
  if (kind === 'wd') return 0.0084 * C.Rsun * Math.pow(m / MSUN, -1 / 3);
  if (kind === 'star') { const q = m / MSUN; return C.Rsun * (q < 1 ? Math.pow(q, 0.8) : Math.pow(q, 0.57)); }
  return 6.371e6 * Math.pow(m / 5.972e24, 0.27);
}
const compact = (b) => b.kind === 'bh' || b.kind === 'ns';
const clampN = (x, a, b) => Math.max(a, Math.min(b, x));

export class NBody {
  constructor() { this.bodies = []; this.t = 0; this.events = []; this.pn = true; this.steps = 0; this.particles = null; this.gw = new GWRecorder(); this.Erad = 0; }
  add(b) { this.bodies.push(b); return b; }
  remove(b) { b.alive = false; this.bodies = this.bodies.filter(x => x !== b); }
  // accelerations of all bodies for positions X and velocities Vv (arrays of [x,y,z])
  accel(X, Vv, A) {
    const n = this.bodies.length;
    for (let i = 0; i < n; i++) { A[i][0] = 0; A[i][1] = 0; A[i][2] = 0; }
    for (let i = 0; i < n; i++) {
      const bi = this.bodies[i];
      for (let j = i + 1; j < n; j++) {
        const bj = this.bodies[j];
        const dx = X[i][0] - X[j][0], dy = X[i][1] - X[j][1], dz = X[i][2] - X[j][2];
        const r2 = dx * dx + dy * dy + dz * dz, r = Math.sqrt(r2), ir3 = 1 / (r2 * r);
        A[i][0] -= G * bj.m * dx * ir3; A[i][1] -= G * bj.m * dy * ir3; A[i][2] -= G * bj.m * dz * ir3;
        A[j][0] += G * bi.m * dx * ir3; A[j][1] += G * bi.m * dy * ir3; A[j][2] += G * bi.m * dz * ir3;
        // post-Newtonian terms between compact objects (black holes, neutron stars): for stars and planets they are
        // negligible or, near a black hole, handled with the Newtonian debris model, which must stay consistent
        if (!this.pn || !(compact(bi) && compact(bj))) continue;
        const M = bi.m + bj.m, GMr = G * M / r;
        // post-Newtonian terms only matter for relativistic pairs; skip when v^2/c^2 is negligible
        const vx = Vv[i][0] - Vv[j][0], vy = Vv[i][1] - Vv[j][1], vz = Vv[i][2] - Vv[j][2], v2 = vx * vx + vy * vy + vz * vz;
        if (GMr < 1e-7 * c2 && v2 < 1e-7 * c2) continue;
        const eta = bi.m * bj.m / (M * M), nx = dx / r, ny = dy / r, nz = dz / r, rd = nx * vx + ny * vy + nz * vz;
        // Kidder (1995) eq. 2.2: a = -(GM/r^2)[(A) n + (B) v], harmonic coordinates
        let Acoef = ((1 + 3 * eta) * v2 - 2 * (2 + eta) * GMr - 1.5 * eta * rd * rd) / c2;
        let Bcoef = (-2 * (2 - eta) * rd) / c2;
        Acoef += -(8 / 5) * eta * GMr * rd * (18 * v2 + (2 / 3) * GMr - 25 * rd * rd) / c5;
        Bcoef += (8 / 5) * eta * GMr * (6 * v2 - 2 * GMr - 15 * rd * rd) / c5;
        const k = -G * M / r2;
        const ax = k * (Acoef * nx + Bcoef * vx), ay = k * (Acoef * ny + Bcoef * vy), az = k * (Acoef * nz + Bcoef * vz);
        // relative acceleration shared by mass ratio
        const fi = bj.m / M, fj = bi.m / M;
        A[i][0] += ax * fi; A[i][1] += ay * fi; A[i][2] += az * fi;
        A[j][0] -= ax * fj; A[j][1] -= ay * fj; A[j][2] -= az * fj;
      }
    }
  }
  // time step from the tightest pair
  stepSize() {
    let h = Infinity; const B = this.bodies;
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
      const dx = B[i].x[0] - B[j].x[0], dy = B[i].x[1] - B[j].x[1], dz = B[i].x[2] - B[j].x[2], r = Math.hypot(dx, dy, dz);
      const vr = Math.hypot(B[i].v[0] - B[j].v[0], B[i].v[1] - B[j].v[1], B[i].v[2] - B[j].v[2]);
      const tdyn = Math.sqrt(r * r * r / (G * (B[i].m + B[j].m)));
      h = Math.min(h, 0.018 * Math.min(tdyn, r / Math.max(vr, 1e-30)));
    }
    return h;
  }
  // classic RK4 over all bodies
  rk4(h) {
    const B = this.bodies, n = B.length;
    const mk = () => Array.from({ length: n }, () => [0, 0, 0]);
    const X0 = B.map(b => b.x.slice()), V0 = B.map(b => b.v.slice());
    const k1v = mk(), k2v = mk(), k3v = mk(), k4v = mk(), X = mk(), Vt = mk();
    this.accel(X0, V0, k1v);
    for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { X[i][a] = X0[i][a] + V0[i][a] * h / 2; Vt[i][a] = V0[i][a] + k1v[i][a] * h / 2; }
    const k2x = Vt.map(v => v.slice()); this.accel(X, Vt, k2v);
    for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { X[i][a] = X0[i][a] + k2x[i][a] * h / 2; Vt[i][a] = V0[i][a] + k2v[i][a] * h / 2; }
    const k3x = Vt.map(v => v.slice()); this.accel(X, Vt, k3v);
    for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { X[i][a] = X0[i][a] + k3x[i][a] * h; Vt[i][a] = V0[i][a] + k3v[i][a] * h; }
    const k4x = Vt.map(v => v.slice()); this.accel(X, Vt, k4v);
    for (let i = 0; i < n; i++) {
      const b = B[i];
      for (let a = 0; a < 3; a++) {
        b.x[a] = X0[i][a] + h / 6 * (V0[i][a] + 2 * k2x[i][a] + 2 * k3x[i][a] + k4x[i][a]);
        b.v[a] = V0[i][a] + h / 6 * (k1v[i][a] + 2 * k2v[i][a] + 2 * k3v[i][a] + k4v[i][a]);
      }
      b.a = k4v[i];
    }
    this.t += h; this.steps++;
  }
  // advance by dt (s), at most maxSteps steps. Returns the time actually advanced.
  advance(dt, maxSteps = 20000) {
    const t0 = this.t, tEnd = this.t + dt;
    let n = 0;
    while (this.t < tEnd && n < maxSteps) {
      if (this.bodies.length < 2) break;
      let h = Math.min(this.stepSize(), tEnd - this.t);
      if (!(h > 0)) h = tEnd - this.t;
      this.rk4(h); n++;
      this.collisions();
      this.gw.sample(this);
      if (this.particles) this.particles.step(this, h);
    }
    if (this.bodies.length < 2 && this.t < tEnd) {
      // a single body drifts; debris still moves in its field
      const rem = tEnd - this.t;
      for (const b of this.bodies) for (let a = 0; a < 3; a++) b.x[a] += b.v[a] * rem;
      if (this.particles) this.particles.step(this, rem);
      this.t = tEnd; this.gw.sample(this);
    }
    this.lastSteps = n;
    return this.t - t0;
  }
  collisions() {
    const B = this.bodies;
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
      const a = B[i], b = B[j];
      const r = Math.hypot(a.x[0] - b.x[0], a.x[1] - b.x[1], a.x[2] - b.x[2]);
      const M = a.m + b.m;
      // tidal disruption of a star (or planet) by a compact object outside its horizon
      const [big, small] = a.m >= b.m ? [a, b] : [b, a];
      if (compact(big) && !compact(small) && small.kind !== 'wd') {
        const rt = small.R * Math.cbrt(big.m / small.m);
        if (r < rt && rt > 3 * big.R) { this.disrupt(big, small); return; }
      }
      let rc = a.R + b.R;
      // compact pairs: past the innermost stable orbit (~5 GM/c^2 in harmonic coordinates) they plunge within an
      // orbit and post-Newtonian dynamics no longer holds: hand over to the merger model
      if (a.kind === 'bh' && b.kind === 'bh') rc = Math.max(rc, 5.5 * G * M / c2);
      else if (compact(a) && compact(b)) rc = Math.max(rc + 8e3, 5.5 * G * M / c2);       // neutron stars touch (tidally stretched)
      if (r < rc) { this.merge(a, b); return; }
    }
  }
  merge(a, b) {
    const M = a.m + b.m, eta = a.m * b.m / (M * M), t = this.t;
    const vcm = [0, 1, 2].map(k => (a.m * a.v[k] + b.m * b.v[k]) / M), xcm = [0, 1, 2].map(k => (a.m * a.x[k] + b.m * b.x[k]) / M);
    let kind = a.m >= b.m ? a.kind : b.kind, m = M, chi = 0, kick = 0, Erad = 0, note = '';
    const bothCompact = compact(a) && compact(b);
    // orbital angular momentum at merger relative to that of a quasi-circular orbit at the same separation:
    // head-on collisions (from rest) radiate far less and leave a non-spinning remnant
    const rv = [a.x[0] - b.x[0], a.x[1] - b.x[1], a.x[2] - b.x[2]], vv = [a.v[0] - b.v[0], a.v[1] - b.v[1], a.v[2] - b.v[2]];
    const Lr = Math.hypot(rv[1] * vv[2] - rv[2] * vv[1], rv[2] * vv[0] - rv[0] * vv[2], rv[0] * vv[1] - rv[1] * vv[0]);
    // fraction of the relative velocity that is tangential: ~1 for an inspiral, 0 for a head-on plunge
    const vtan = Lr / Math.max(Math.hypot(...rv), 1e-9), vtot = Math.hypot(...vv) || 1;
    const xq = clampN((vtan / vtot - 0.2) / 0.5, 0, 1), circ = xq * xq * (3 - 2 * xq);
    if (bothCompact) {
      // numerical relativity fits for non-spinning quasi-circular binaries (Healy, Lousto & Zlochower; Gonzalez et al.
      // 2007), blended towards head-on values (Sperhake et al.: ~0.06% of the mass radiated, no spin) as L -> 0
      const Ef = (0.0559745 * eta + 0.580951 * eta * eta - 0.960673 * eta ** 3 + 3.35241 * eta ** 4) * circ * circ + 0.0024 * eta * (1 - circ * circ);
      chi = Math.min(0.998, (2 * Math.sqrt(3) * eta - 3.871 * eta * eta + 4.028 * eta ** 3) * circ);
      kick = 1.2e4 * eta * eta * Math.sqrt(Math.max(0, 1 - 4 * eta)) * (1 - 0.93 * eta) * 1e3 * (0.3 + 0.7 * circ);   // m/s
      Erad = (a.kind === 'bh' && b.kind === 'bh' ? Ef : Ef * 0.6) * M;
      m = M - Erad;
      if (a.kind === 'ns' && b.kind === 'ns') {
        kind = M > 2.6 * MSUN ? 'bh' : 'ns'; kick = 0; chi = kind === 'bh' ? 0.7 : 0;
        note = kind === 'bh' ? 'Neutron stars merged and collapsed to a black hole. Kilonova!' : 'Neutron stars merged into a massive neutron star. Kilonova!';
        m -= 0.05 * MSUN;     // ejecta
      } else if (a.kind === 'bh' && b.kind === 'bh') note = `Black holes merged: ${(Erad * c2 / 1.989e30 / c2).toFixed(2)} solar masses radiated as gravitational waves`;
      else { kind = 'bh'; note = 'The neutron star plunged into the black hole'; }
    } else if (compact(a) || compact(b)) { kind = compact(a) ? a.kind : b.kind; note = (compact(a) ? b : a).name + ' was swallowed'; }
    else if (a.kind === 'star' || b.kind === 'star') { kind = 'star'; note = 'Stellar collision: the stars merged'; }
    else { note = 'Collision: the bodies merged'; }
    // recoil in the orbital plane, perpendicular to the separation at merger (direction depends on the phase)
    const rel = [0, 1, 2].map(k => a.x[k] - b.x[k]), vrel = [0, 1, 2].map(k => a.v[k] - b.v[k]);
    const nrm = [rel[1] * vrel[2] - rel[2] * vrel[1], rel[2] * vrel[0] - rel[0] * vrel[2], rel[0] * vrel[1] - rel[1] * vrel[0]];
    const nl = Math.hypot(...nrm) || 1, rl = Math.hypot(...rel) || 1;
    const dir = [(nrm[1] * rel[2] - nrm[2] * rel[1]) / (nl * rl), (nrm[2] * rel[0] - nrm[0] * rel[2]) / (nl * rl), (nrm[0] * rel[1] - nrm[1] * rel[0]) / (nl * rl)];
    const v = vcm.map((x, k) => x + dir[k] * kick);
    const big = a.m >= b.m ? a : b;
    const nb = makeBody(kind, m, xcm, v, { name: kind === 'bh' && bothCompact ? 'Remnant black hole' : big.name, chi, merged: true });
    if (kind === 'star') { nb.R = radiusFor('star', m); nb.flash = { t, L: 1e4 }; }
    this.remove(a); this.remove(b); this.add(nb);
    this.Erad += Erad;
    const ev = { t, a: a.name, b: b.name, note, kick, chi, Erad, mf: m, M, eta, body: nb, kindA: a.kind, kindB: b.kind };
    if (bothCompact) {
      // ringdown of the final black hole (Berti, Cardoso & Will 2006 fits for the l = m = 2 mode)
      const Mf = m;
      ev.fRD = c * c * c / (2 * Math.PI * G * Mf) * (1.5251 - 1.1568 * Math.pow(1 - chi, 0.1292));
      ev.Q = 0.7 + 1.4187 * Math.pow(1 - chi, -0.4990);
      ev.tau = ev.Q / (Math.PI * ev.fRD);
      if (a.kind === 'ns' || b.kind === 'ns') ev.kilonova = a.kind === 'ns' && b.kind === 'ns';
      this.gw.ringdown(ev, this);
    }
    if (ev.kilonova) nb.kilonova = { t, x: xcm.slice() };
    // a short gamma ray burst: a relativistic jet along the remnant's spin (the orbital angular momentum)
    if ((a.kind === 'ns' || b.kind === 'ns') && kind === 'bh') nb.grb = { t, axis: [nrm[0] / nl, nrm[1] / nl, nrm[2] / nl] };
    this.events.push(ev);
    if (this.onEvent) this.onEvent(ev);
  }
  // a star torn apart by tides: replace it with debris particles that follow the compact object's gravity
  disrupt(bh, star) {
    const n = 2500, P = this.particles || (this.particles = new Debris());
    P.addStar(star, bh, n);
    this.remove(star);
    const ev = { t: this.t, note: `${star.name} was torn apart by tides (tidal disruption event)`, tde: true, body: bh };
    this.events.push(ev); if (this.onEvent) this.onEvent(ev);
  }
  energy() {
    let E = 0; const B = this.bodies;
    for (const b of B) E += 0.5 * b.m * (b.v[0] ** 2 + b.v[1] ** 2 + b.v[2] ** 2);
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) E -= G * B[i].m * B[j].m / Math.hypot(B[i].x[0] - B[j].x[0], B[i].x[1] - B[j].x[1], B[i].x[2] - B[j].x[2]);
    return E;
  }
  clone() {
    const o = new NBody(); o.t = this.t; o.pn = this.pn; o.Erad = this.Erad;
    o.bodies = this.bodies.map(b => Object.assign({}, b, { x: b.x.slice(), v: b.v.slice() }));
    o.events = this.events.slice(); o.particles = this.particles ? this.particles.clone() : null; o.gw = this.gw;
    return o;
  }
}

// Debris of a tidally disrupted star: test particles in the field of all bodies. Particles that fall within a few
// Schwarzschild radii are accreted; the accretion rate (and so the flare) follows the famous t^-5/3 fallback.
export class Debris {
  constructor() { this.x = new Float64Array(0); this.v = new Float64Array(0); this.n = 0; this.mp = 0; this.acc = []; this.T = new Float32Array(0); this.out = new Uint8Array(0); this.racc = 0; }
  clone() { const d = new Debris(); d.x = this.x.slice(); d.v = this.v.slice(); d.n = this.n; d.mp = this.mp; d.acc = this.acc.slice(); d.T = this.T.slice(); d.out = this.out.slice(); d.racc = this.racc; d.bh = this.bh; return d; }
  addStar(star, bh, n) {
    const x = new Float64Array((this.n + n) * 3), v = new Float64Array((this.n + n) * 3), T = new Float32Array(this.n + n);
    x.set(this.x); v.set(this.v); T.set(this.T);
    // particles fill the star; the star's own spin-up and self gravity are neglected: the tidal field does the rest
    let s = 12345;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let i = this.n; i < this.n + n; i++) {
      let px, py, pz; do { px = rnd() * 2 - 1; py = rnd() * 2 - 1; pz = rnd() * 2 - 1; } while (px * px + py * py + pz * pz > 1);
      x[i * 3] = star.x[0] + px * star.R; x[i * 3 + 1] = star.x[1] + py * star.R; x[i * 3 + 2] = star.x[2] + pz * star.R;
      v[i * 3] = star.v[0]; v[i * 3 + 1] = star.v[1]; v[i * 3 + 2] = star.v[2]; T[i] = 6000;
    }
    const out = new Uint8Array(this.n + n); if (this.out) out.set(this.out);
    this.x = x; this.v = v; this.T = T; this.out = out; this.mp = star.m / n; this.n += n; this.bh = bh;
    // returning debris shocks and circularises near the star's pericentre: count it as accreted there
    const r = Math.hypot(star.x[0] - bh.x[0], star.x[1] - bh.x[1], star.x[2] - bh.x[2]);
    this.racc = Math.max(this.racc || 0, 0.9 * r);
  }
  step(sim, h) {
    if (!(h > 0)) return;
    const B = sim.bodies, x = this.x, v = this.v, acc = [0, 0, 0];
    // acceleration on particle i; returns its dynamical time, or -1 if it fell into a black hole
    const accel = (i) => {
      let tmin = Infinity; acc[0] = acc[1] = acc[2] = 0;
      for (const b of B) {
        const dx = x[i * 3] - b.x[0], dy = x[i * 3 + 1] - b.x[1], dz = x[i * 3 + 2] - b.x[2], r2 = dx * dx + dy * dy + dz * dz, r = Math.sqrt(r2);
        if (b.kind === 'bh' && (r < 3 * b.R || (b === this.bh && this.out[i] && r < this.racc))) return -1;
        if (b === this.bh && r > 3 * this.racc) this.out[i] = 1;
        const k = -G * b.m / (r2 * r); acc[0] += k * dx; acc[1] += k * dy; acc[2] += k * dz;
        const td = Math.sqrt(r2 * r / (G * b.m)); if (td < tmin) tmin = td;
      }
      return tmin;
    };
    // leapfrog (kick-drift-kick) with a step of 1/200 of the local dynamical time: the debris' fate (bound or
    // not) depends on an energy spread of ~1% of the pericentre potential, so the integration must be accurate
    let accreted = 0;
    for (let i = 0; i < this.n; i++) {
      if (x[i * 3] !== x[i * 3]) continue;   // NaN = accreted
      let left = h, guard = 0;
      while (left > 0 && guard++ < 200000) {
        let td = accel(i);
        if (td < 0) { x[i * 3] = NaN; accreted++; break; }
        const dt = Math.min(left, 0.005 * td);
        v[i * 3] += acc[0] * dt * 0.5; v[i * 3 + 1] += acc[1] * dt * 0.5; v[i * 3 + 2] += acc[2] * dt * 0.5;
        x[i * 3] += v[i * 3] * dt; x[i * 3 + 1] += v[i * 3 + 1] * dt; x[i * 3 + 2] += v[i * 3 + 2] * dt;
        td = accel(i);
        if (td < 0) { x[i * 3] = NaN; accreted++; break; }
        v[i * 3] += acc[0] * dt * 0.5; v[i * 3 + 1] += acc[1] * dt * 0.5; v[i * 3 + 2] += acc[2] * dt * 0.5;
        left -= dt;
      }
    }
    if (accreted) this.acc.push([sim.t, accreted * this.mp]);
    // keep a short history of the accretion rate
    while (this.acc.length > 2 && sim.t - this.acc[0][0] > 30 * 86400) this.acc.shift();
  }
  // accretion rate (kg/s) averaged over the recent past
  mdot(t) {
    let m = 0, t0 = Infinity; for (const [ta, ma] of this.acc) { if (t - ta < 2 * 86400) { m += ma; t0 = Math.min(t0, ta); } }
    return m / Math.max(2 * 86400, 1);
  }
}

// Records gravitational wave strain at a fiducial distance from the second time derivative of the mass
// quadrupole (quadrupole formula), and synthesises the ringdown after a merger.
export class GWRecorder {
  constructor() { this.buf = []; this.max = 6000; this.rd = null; this.D = 100 * 3.0857e22; this.lastT = -Infinity; this.lastF = 0; }
  qdd(sim) {
    // reduced quadrupole second derivative about the centre of mass: Q''_ij = sum m (2 v_i v_j + x_i a_j + a_i x_j), trace removed
    const B = sim.bodies; let M = 0; const cm = [0, 0, 0], vc = [0, 0, 0];
    for (const b of B) { M += b.m; for (let k = 0; k < 3; k++) { cm[k] += b.m * b.x[k]; vc[k] += b.m * b.v[k]; } }
    for (let k = 0; k < 3; k++) { cm[k] /= M; vc[k] /= M; }
    const q = [0, 0, 0, 0, 0, 0];   // xx yy zz xy xz yz
    const idx = [[0, 0], [1, 1], [2, 2], [0, 1], [0, 2], [1, 2]];
    for (const b of B) {
      const x = [b.x[0] - cm[0], b.x[1] - cm[1], b.x[2] - cm[2]], v = [b.v[0] - vc[0], b.v[1] - vc[1], b.v[2] - vc[2]], a = b.a || [0, 0, 0];
      idx.forEach(([i, j], k) => { q[k] += b.m * (2 * v[i] * v[j] + x[i] * a[j] + a[i] * x[j]); });
    }
    const tr = (q[0] + q[1] + q[2]) / 3; q[0] -= tr; q[1] -= tr; q[2] -= tr;
    return q;
  }
  sample(sim) {
    const t = sim.t;
    // sample about 40 times per orbit of the tightest pair, or after a merger along the ringdown
    if (this.rd && t < this.rd.t0 + 12 * this.rd.tau) { this.pushRing(t); return; }
    const B = sim.bodies;
    let per = Infinity;
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) { const r = Math.hypot(B[i].x[0] - B[j].x[0], B[i].x[1] - B[j].x[1], B[i].x[2] - B[j].x[2]); per = Math.min(per, 2 * Math.PI * Math.sqrt(r * r * r / (G * (B[i].m + B[j].m)))); }
    if (B.length < 2) { if (t - this.lastT > 0.05 * (this.lastPer || 1)) this.push(t, [0, 0, 0, 0, 0, 0], 0); return; }
    if (t - this.lastT < per / 40) return;
    this.lastPer = per;
    this.push(t, this.qdd(sim), 2 / per);
  }
  push(t, q, f) { this.buf.push({ t, q, f }); this.lastT = t; if (this.buf.length > this.max) this.buf.splice(0, this.buf.length - this.max); }
  // after merger: a damped sinusoid continuing from the last inspiral sample, sweeping quickly up to the
  // quasi-normal mode frequency (a simple merger-ringdown model)
  ringdown(ev, sim) {
    const last = this.buf[this.buf.length - 1];
    const q0 = last ? last.q : [0, 0, 0, 0, 0, 0];
    const A = Math.hypot(q0[0] - q0[2], 2 * q0[4]) * 1.4;
    // orbital plane basis: assume the angular momentum of the merged pair
    this.rd = { t0: ev.t, f0: last ? last.f : ev.fRD * 0.5, fRD: ev.fRD, tau: ev.tau, A, ph: Math.atan2(2 * q0[4], q0[0] - q0[2]), Q: ev.Q };
    this.pushRing(ev.t);
  }
  pushRing(t) {
    const r = this.rd, dt = t - r.t0;
    // phase: frequency rises from f0 to fRD over ~ one ringdown time, then the mode rings down
    const fr = r.fRD - (r.fRD - r.f0) * Math.exp(-dt / (0.6 * r.tau));
    if (!r.phAcc) { r.phAcc = r.ph; r.lt = t; }
    r.phAcc += 2 * Math.PI * fr * (t - r.lt); r.lt = t;
    const amp = r.A * (dt < 0.3 * r.tau ? 1 + dt / (0.3 * r.tau) * 0.25 : 1.25 * Math.exp(-(dt - 0.3 * r.tau) / r.tau));
    const hp = amp * Math.cos(r.phAcc), hx = amp * Math.sin(r.phAcc);
    // encode as a quadrupole in the x-z plane with the same face-on strain
    this.push(t, [hp / 2, 0, -hp / 2, 0, hx / 2, 0], fr);
    if (dt > 12 * r.tau) this.rd = null;
  }
  // face-on strain (h+, hx) at the fiducial distance D for a given sample; orbital plane is x-z (y up)
  strain(s, D = this.D) { const k = G / (c2 * c2 * D); return [k * (s.q[0] - s.q[2]), k * 2 * s.q[4]]; }
  // strain seen from direction n (unit) at distance D
  strainDir(s, n, D = this.D) {
    const q = s.q; const Q = [[q[0], q[3], q[4]], [q[3], q[1], q[5]], [q[4], q[5], q[2]]];
    let e1 = Math.abs(n[1]) < 0.99 ? [n[2], 0, -n[0]] : [1, 0, 0]; const l = Math.hypot(...e1); e1 = e1.map(x => x / l);
    const e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
    const qq = (a, b) => { let s2 = 0; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s2 += a[i] * Q[i][j] * b[j]; return s2; };
    const k = G / (c2 * c2 * D);
    return [k * (qq(e1, e1) - qq(e2, e2)), k * 2 * qq(e1, e2)];
  }
  // value at time t (linear interpolation), or null
  at(t) {
    const b = this.buf; if (!b.length || t < b[0].t || t > b[b.length - 1].t) return null;
    let lo = 0, hi = b.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (b[m].t <= t) lo = m; else hi = m; }
    const s0 = b[lo], s1 = b[hi], f = s1.t > s0.t ? (t - s0.t) / (s1.t - s0.t) : 0;
    return { t, q: s0.q.map((x, i) => x + (s1.q[i] - x) * f), f: s0.f + (s1.f - s0.f) * f };
  }
}

// Peters (1964) time to coalescence of a circular binary
export function petersTime(m1, m2, a) { return 5 / 256 * c5 * a ** 4 / (G ** 3 * m1 * m2 * (m1 + m2)); }
export function separationForTime(m1, m2, T) { return Math.pow(T * 256 / 5 * G ** 3 * m1 * m2 * (m1 + m2) / c5, 0.25); }
// Initial conditions for a quasi-circular binary in harmonic coordinates: 1PN orbital frequency
// w^2 = GM/r^3 [1 - (3 - eta) GM/(r c^2)] and the 2.5PN inspiral rate dr/dt = -(64/5) G^3 m1 m2 M / (c^5 r^3).
// Returns relative speed (tangential) and radial velocity.
export function circularBinary(m1, m2, r, pn = true) {
  const M = m1 + m2, eta = m1 * m2 / (M * M), x = G * M / (r * c2);
  const w2 = G * M / (r * r * r) * (pn ? 1 - (3 - eta) * x : 1);
  return { vt: Math.sqrt(w2) * r, vr: pn ? -64 / 5 * G ** 3 * m1 * m2 * M / (c5 * r ** 3) : 0 };
}
// place a binary in the x-z plane (y up) about the origin; returns [body1, body2]
export function binary(sim, k1, m1, k2, m2, r, opt = {}) {
  const M = m1 + m2, { vt, vr } = circularBinary(m1, m2, r, sim.pn);
  const e = opt.e || 0, vte = vt * Math.sqrt(1 + e);   // e > 0: start at pericentre
  const b1 = makeBody(k1, m1, [r * m2 / M, 0, 0], [vr * m2 / M, 0, -vte * m2 / M], { name: opt.n1 || 'A' });
  const b2 = makeBody(k2, m2, [-r * m1 / M, 0, 0], [-vr * m1 / M, 0, vte * m1 / M], { name: opt.n2 || 'B' });
  sim.add(b1); sim.add(b2); return [b1, b2];
}
