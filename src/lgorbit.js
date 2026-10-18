// The Milky Way - Andromeda orbit. Units: kpc, Myr, solar masses.
// Each galaxy: NFW dark halo + Hernquist bulge + Miyamoto-Nagai disk. The centres move under their mutual
// (spherically averaged) gravity plus Chandrasekhar dynamical friction of each against the other's halo,
// starting from M31's measured distance and velocity (van der Marel et al. 2012: 770 kpc, -109 km/s radial,
// tangential ~17-57 km/s; we use 30), giving a first passage at 3.8 Gyr (35 kpc), a second at 5.3 Gyr and a merger at 6.0 Gyr.
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const G = 4.4985e-12;                   // kpc^3 / (Msun Myr^2)
export const KMS = 1.02271e-3;                 // km/s in kpc/Myr
export const GAL = {
  mw: { Mh: 1.0e12, c: 10, Mb: 1.0e10, ab: 0.7, Md: 6.0e10, ad: 3.5, bd: 0.3, Rd: 2.6, L: 2.5e10 },
  m31: { Mh: 1.5e12, c: 10, Mb: 3.0e10, ab: 1.0, Md: 7.0e10, ad: 5.5, bd: 0.4, Rd: 5.3, L: 4.0e10 },
};
for (const g of Object.values(GAL)) {
  g.r200 = 206 * Math.cbrt(g.Mh / 1e12); g.rs = g.r200 / g.c;
  g.mnorm = Math.log(1 + g.c) - g.c / (1 + g.c);
  g.Mtot = g.Mh + g.Mb + g.Md;
}
// mass enclosed within r (spherical approximation of all components)
export function Menc(g, r) {
  const x = r / g.rs;
  const h = g.Mh * Math.min(1.25, (Math.log(1 + x) - x / (1 + x)) / g.mnorm);
  const b = g.Mb * r * r / ((r + g.ab) ** 2);
  const d = g.Md * (1 - (1 + r / g.Rd) * Math.exp(-r / g.Rd));
  return h + b + d;
}
export function rhoHalo(g, r) { const x = Math.max(r / g.rs, 1e-3); return g.Mh / g.mnorm / (4 * Math.PI * g.rs ** 3) / (x * (1 + x) ** 2); }
const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };

// direction to M31 from the Sun (galactic l = 121.17, b = -21.57) in the Milky Way frame (x to the centre, y north)
const l = 121.17 * Math.PI / 180, b = -21.57 * Math.PI / 180;
const DIR = [Math.cos(b) * Math.cos(l), Math.sin(b), -Math.cos(b) * Math.sin(l)];
const SUN = [-8.2, 0.02, 0];
export const R0 = [SUN[0] + DIR[0] * 765, SUN[1] + DIR[1] * 765, SUN[2] + DIR[2] * 765];
const r0l = Math.hypot(...R0), rhat = R0.map(x => x / r0l);
let that = [rhat[2], 0, -rhat[0]]; { const n = Math.hypot(...that); that = that.map(x => x / n); }
export const V0 = rhat.map((x, i) => (-109.3 * x + 30 * that[i]) * KMS);

const LNL = 1.5;   // Coulomb logarithm (tuned with the tangential velocity to the published orbit)
function accRel(r, v) {
  // relative acceleration of M31 with respect to the Milky Way
  const d = Math.hypot(...r), M = GAL.mw, A = GAL.m31;
  const s = Math.max(d, 0.5);
  const grav = -G * (Menc(M, s) + Menc(A, s)) / (s * s * s);
  const a = r.map(x => x * grav);
  const vv = Math.hypot(...v);
  if (vv > 1e-9) {
    // dynamical friction: each galaxy's mass moving through the other's halo (sigma ~ v_circ / sqrt 2)
    const sig = Math.sqrt(G * (Menc(M, s) + Menc(A, s)) / s) / Math.SQRT2;
    const X = vv / (Math.SQRT2 * sig), f = erf(X) - 2 * X / Math.sqrt(Math.PI) * Math.exp(-X * X);
    // the satellites lose their outer halos as they plunge: only the mass within a few tens of kpc drags
    const msat = Menc(A, Math.min(s, 60)) + Menc(M, Math.min(s, 60));
    const k = -4 * Math.PI * G * G * LNL * msat * 0.5 * (rhoHalo(M, s) + rhoHalo(A, s)) * f / (vv ** 3);
    for (let i = 0; i < 3; i++) a[i] += k * v[i];
  }
  return a;
}
// relative orbit table: every 2 Myr from now to 20 Gyr
export const ORBIT = (() => {
  const dt = 0.5, N = 40000, every = 4, tab = [];
  let r = R0.slice(), v = V0.slice(), merged = -1;
  for (let i = 0; i <= N; i++) {
    if (i % every === 0) tab.push([r[0], r[1], r[2], v[0], v[1], v[2]]);
    if (merged >= 0) continue;
    // RK4
    const k1v = accRel(r, v), k1r = v;
    const r2 = r.map((x, j) => x + k1r[j] * dt / 2), v2 = v.map((x, j) => x + k1v[j] * dt / 2), k2v = accRel(r2, v2), k2r = v2;
    const r3 = r.map((x, j) => x + k2r[j] * dt / 2), v3 = v.map((x, j) => x + k2v[j] * dt / 2), k3v = accRel(r3, v3), k3r = v3;
    const r4 = r.map((x, j) => x + k3r[j] * dt), v4 = v.map((x, j) => x + k3v[j] * dt), k4v = accRel(r4, v4), k4r = v4;
    r = r.map((x, j) => x + dt / 6 * (k1r[j] + 2 * k2r[j] + 2 * k3r[j] + k4r[j]));
    v = v.map((x, j) => x + dt / 6 * (k1v[j] + 2 * k2v[j] + 2 * k3v[j] + k4v[j]));
    if (Math.hypot(...r) < 1.0 && Math.hypot(...v) < 60 * KMS) { merged = i * dt; r = [0, 0, 0]; v = [0, 0, 0]; }
  }
  tab.dt = dt * every; tab.merged = merged;
  return tab;
})();
// the past: the "timing argument" (Kahn & Woltjer 1959). The two galaxies formed close together, flew apart with the
// Hubble flow, were slowed by their mutual gravity, turned around ~5 Gyr ago at ~1 Mpc and have been falling together since.
// Run backwards from today as two point masses (their halos overlap at these separations) plus the dark-energy
// repulsion H0^2 Omega_L r; the mass that brings them together at the Big Bang is 4.9e12 Msun (van der Marel et al. 2012: 4.93e12).
export const M_TIMING = 4.9e12;
export const PAST = (() => {
  const H2L = (67.7 * KMS / 1000) ** 2 * 0.69, dt = -0.5, every = 8, N = 27600, tab = [];
  const acc = (r) => { const s = Math.max(Math.hypot(...r), 5); const g = -G * M_TIMING / (s * s * s) + H2L; return r.map(x => x * g); };
  let r = R0.slice(), v = V0.slice();
  for (let i = 0; i <= N; i++) {
    if (i % every === 0) tab.push([r[0], r[1], r[2], v[0], v[1], v[2]]);
    const k1 = acc(r), r2 = r.map((x, j) => x + v[j] * dt / 2), v2 = v.map((x, j) => x + k1[j] * dt / 2);
    const k2 = acc(r2), r3 = r.map((x, j) => x + v2[j] * dt / 2), v3 = v.map((x, j) => x + k2[j] * dt / 2);
    const k3 = acc(r3), r4 = r.map((x, j) => x + v3[j] * dt), v4 = v.map((x, j) => x + k3[j] * dt);
    const k4 = acc(r4);
    r = r.map((x, j) => x + dt / 6 * (v[j] + 2 * v2[j] + 2 * v3[j] + v4[j]));
    v = v.map((x, j) => x + dt / 6 * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
  }
  tab.dt = -dt * every;
  // turnaround: the widest separation
  let im = 0; for (let i = 0; i < tab.length; i++) if (Math.hypot(tab[i][0], tab[i][1], tab[i][2]) > Math.hypot(tab[im][0], tab[im][1], tab[im][2])) im = i;
  tab.turn = im * tab.dt;   // (Myr ago)
  tab.rTurn = Math.hypot(tab[im][0], tab[im][1], tab[im][2]);
  return tab;
})();
export function pastAt(tMyr) {
  const f = Math.max(0, Math.min(PAST.length - 1.001, -tMyr / PAST.dt)), i = Math.floor(f), u = f - i;
  const a = PAST[i], c = PAST[i + 1];
  return { r: [a[0] + (c[0] - a[0]) * u, a[1] + (c[1] - a[1]) * u, a[2] + (c[2] - a[2]) * u], v: [a[3] + (c[3] - a[3]) * u, a[4] + (c[4] - a[4]) * u, a[5] + (c[5] - a[5]) * u] };
}
// relative vector MW -> M31 (kpc) and velocity (kpc/Myr) at tMyr from now
export function relAt(tMyr) {
  if (tMyr < 0) return pastAt(tMyr);
  const f = Math.max(0, Math.min(ORBIT.length - 1.001, tMyr / ORBIT.dt)), i = Math.floor(f), u = f - i;
  const a = ORBIT[i], c = ORBIT[i + 1];
  return { r: [a[0] + (c[0] - a[0]) * u, a[1] + (c[1] - a[1]) * u, a[2] + (c[2] - a[2]) * u], v: [a[3] + (c[3] - a[3]) * u, a[4] + (c[4] - a[4]) * u, a[5] + (c[5] - a[5]) * u] };
}
// centres in the centre of mass frame
export function centresAt(tMyr) {
  const { r, v } = relAt(tMyr), Mm = GAL.mw.Mtot, Ma = GAL.m31.Mtot, M = Mm + Ma;
  return { mw: r.map(x => -x * Ma / M), m31: r.map(x => x * Mm / M), vmw: v.map(x => -x * Ma / M), vm31: v.map(x => x * Mm / M), r };
}
// key moments of the orbit (pericentre passages, merger), for the timeline
export function orbitEvents() {
  const ev = []; let prev = Infinity, prev2 = Infinity;
  for (let i = 0; i < ORBIT.length; i++) {
    const d = Math.hypot(ORBIT[i][0], ORBIT[i][1], ORBIT[i][2]);
    if (prev < prev2 && prev < d && prev > 0.5) ev.push({ t: (i - 1) * ORBIT.dt, d: prev });
    prev2 = prev; prev = d;
  }
  return { pericentres: ev, merged: ORBIT.merged };
}

// The Large Magellanic Cloud (with the SMC bound to it): on its first infall, now 50 kpc out and moving at 321 km/s
// (Kallivayalil et al. 2013 proper motions), 1.4e11 Msun with its dark halo (Erkal et al. 2019). Dynamical friction in
// the Milky Way's halo drags it in: it merges ~2.3 Gyr from now (Cautun et al. 2019: 2.4 +- 0.8 Gyr). Run backwards it
// comes in from beyond 300 kpc two billion years ago.
export const LMC_ORBIT = (() => {
  const D2R = Math.PI / 180, l = 280.47 * D2R, b = -32.89 * D2R, M = 1.4e11, LNL = 4;
  const r0 = [SUN[0] + Math.cos(b) * Math.cos(l) * 49.9, SUN[1] + Math.sin(b) * 49.9, SUN[2] - Math.cos(b) * Math.sin(l) * 49.9];
  const v0 = [-57, 221, 226].map(x => x * KMS);      // galactocentric (X, Z, -Y) of Kallivayalil et al. (-57, -226, 221) km/s
  const acc = (r, v) => {
    const d = Math.max(Math.hypot(...r), 0.3), m = Menc(GAL.mw, d), a = r.map(x => -x * G * m / d ** 3);
    const vv = Math.hypot(...v), sig = Math.sqrt(G * m / d) / Math.SQRT2, X = vv / (Math.SQRT2 * sig), f = erf(X) - 2 * X / Math.sqrt(Math.PI) * Math.exp(-X * X);
    const k = -4 * Math.PI * G * G * LNL * M * rhoHalo(GAL.mw, d) * f / Math.max(vv ** 3, 1e-12);
    for (let i = 0; i < 3; i++) a[i] += k * v[i];
    return a;
  };
  const run = (dt, N) => {
    let r = r0.slice(), v = v0.slice(); const tab = [r.slice()]; let merged = -1;
    for (let i = 1; i <= N; i++) {
      if (merged < 0) {
        const k1 = acc(r, v), r2 = r.map((x, j) => x + v[j] * dt / 2), v2 = v.map((x, j) => x + k1[j] * dt / 2), k2 = acc(r2, v2);
        const r3 = r.map((x, j) => x + v2[j] * dt / 2), v3 = v.map((x, j) => x + k2[j] * dt / 2), k3 = acc(r3, v3);
        const r4 = r.map((x, j) => x + v3[j] * dt), v4 = v.map((x, j) => x + k3[j] * dt), k4 = acc(r4, v4);
        r = r.map((x, j) => x + dt / 6 * (v[j] + 2 * v2[j] + 2 * v3[j] + v4[j])); v = v.map((x, j) => x + dt / 6 * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
        if (dt > 0 && Math.hypot(...r) < 3 && Math.hypot(...v) < 100 * KMS) { merged = i * dt; r = [0, 0, 0]; }
      }
      tab.push(r.slice());
    }
    tab.merged = merged; return tab;
  };
  const fwd = run(1, 3500), back = run(-1, 3500);
  return { fwd, back, merged: fwd.merged, r0 };
})();
// LMC centre (kpc, Milky Way frame) at tMyr from now
export function lmcAt(tMyr) {
  const tab = tMyr >= 0 ? LMC_ORBIT.fwd : LMC_ORBIT.back, f = Math.min(Math.abs(tMyr), tab.length - 1.001), i = Math.floor(f), u = f - i;
  return [0, 1, 2].map(j => tab[i][j] + (tab[i + 1][j] - tab[i][j]) * u);
}

// The Sagittarius dwarf spheroidal: on a polar orbit through the Milky Way's disk (pericentre ~15 kpc, apocentre ~50-60
// kpc, period ~0.8 Gyr), now 18 kpc from the centre just past a disk crossing and being torn into the stream that wraps
// the sky. Position from l, b, d = 5.57, -14.17, 26.5 kpc and velocity (237.9, -24.3, 209.0) km/s galactocentric
// (Vasiliev & Belokurov 2020). Its bound mass is ~4e8 Msun now; it was ~1e10 when it fell in, so dynamical friction is
// scaled up into the past. It is expected to dissolve within about a billion years.
export const SGR_ORBIT = (() => {
  const D2R = Math.PI / 180, l = 5.57 * D2R, b = -14.17 * D2R, d = 26.5, LNL = 3;
  const r0 = [SUN[0] + Math.cos(b) * Math.cos(l) * d, SUN[1] + Math.sin(b) * d, SUN[2] - Math.cos(b) * Math.sin(l) * d];
  const v0 = [237.9, 209.0, 24.3].map(x => x * KMS);
  const acc = (r, v, t) => {
    const M = 4e8 * Math.pow(10, clamp(-t / 2000, 0, 1.4));
    const dd = Math.max(Math.hypot(...r), 0.3), m = Menc(GAL.mw, dd), a = r.map(x => -x * G * m / dd ** 3);
    const vv = Math.hypot(...v), sig = Math.sqrt(G * m / dd) / Math.SQRT2, X = vv / (Math.SQRT2 * sig), f = erf(X) - 2 * X / Math.sqrt(Math.PI) * Math.exp(-X * X);
    const k = -4 * Math.PI * G * G * LNL * M * rhoHalo(GAL.mw, dd) * f / Math.max(vv ** 3, 1e-12);
    for (let i = 0; i < 3; i++) a[i] += k * v[i];
    return a;
  };
  const run = (dt, N) => {
    let r = r0.slice(), v = v0.slice(); const tab = [r.slice()];
    for (let i = 1; i <= N; i++) for (let s = 0; s < 4; s++) {
      const t = (i - 1 + s / 4) * dt, h = dt / 4;
      const k1 = acc(r, v, t), r2 = r.map((x, j) => x + v[j] * h / 2), v2 = v.map((x, j) => x + k1[j] * h / 2), k2 = acc(r2, v2, t);
      const r3 = r.map((x, j) => x + v2[j] * h / 2), v3 = v.map((x, j) => x + k2[j] * h / 2), k3 = acc(r3, v3, t);
      const r4 = r.map((x, j) => x + v3[j] * h), v4 = v.map((x, j) => x + k3[j] * h), k4 = acc(r4, v4, t);
      r = r.map((x, j) => x + h / 6 * (v[j] + 2 * v2[j] + 2 * v3[j] + v4[j])); v = v.map((x, j) => x + h / 6 * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
      if (s === 3) tab.push(r.slice());
    }
    return tab;
  };
  return { fwd: run(1, 1500), back: run(-1, 6000), r0 };
})();
export function sgrAt(tMyr) {
  const tab = tMyr >= 0 ? SGR_ORBIT.fwd : SGR_ORBIT.back, f = Math.min(Math.abs(tMyr), tab.length - 1.001), i = Math.floor(f), u = f - i;
  return [0, 1, 2].map(j => tab[i][j] + (tab[i + 1][j] - tab[i][j]) * u);
}
