// Stellar evolution for every star you can visit (the Sun has its own detailed track in evolution.js).
// Each star gets a present age from its hash; time then moves it along a simple track scaled to its mass:
// main sequence brightening (lifetime 10 Gyr (M/M_sun)^-2.5), subgiant and giant branches, then either a planetary
// nebula and a white dwarf that cools for trillions of years (below 8 M_sun) or a supernova that leaves a neutron star
// (8-20 M_sun) or a black hole. Mass loss widens planetary orbits; planets inside a giant's envelope are swallowed.
import { C, clamp } from './math.js';
import { KIND } from './stars.js';

const MS = 0, GIANT = 1, SUPERGIANT = 2, WD = 3;
export const tMS = (m) => Math.max(3.5e6, 1e10 * Math.pow(Math.max(m, 0.08), -2.5));
const hashf = (x, k) => { let h = (Math.floor(x) * 2654435761 + k * 40503) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h = (h ^ (h >>> 12)) >>> 0; return (h % 100000) / 100000; };
// main sequence shape (relative): luminosity and radius at fraction x of the lifetime (Sun-like)
const msL = (x) => 0.7 + 0.6 * x + 0.6 * x * x * x, msR = (x) => 0.89 + 0.2 * x + 0.45 * x * x * x;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// measured ages (Gyr) of well-known stars (asteroseismology, isochrones, white dwarf cooling, gyrochronology); the
// rest get an age from their hash
export const KNOWN_AGE = { 'rigil kentaurus': 5.3, 'toliman': 5.3, 'proxima centauri': 4.85, 'sirius': 0.24, 'vega': 0.455, 'altair': 0.1,
  'procyon': 1.87, 'tau ceti': 5.8, 'epsilon eridani': 0.6, 'ran': 0.6, "barnard's star": 10, 'trappist-1': 7.6, '61 cygni': 6.1,
  'fomalhaut': 0.44, 'polaris': 0.07, 'capella': 0.59, 'pollux': 0.72, 'regulus': 0.05, 'achernar': 0.06, 'canopus': 0.025,
  '51 pegasi': 6.1, 'helvetios': 6.1, 'deneb': 0.01, 'castor': 0.29, 'alcyone': 0.1, 'mizar': 0.37, 'alderamin': 0.82 };
// set up the evolutionary state of a star body (once)
// (ageYr: the age of the system's primary, so that the stars of a binary or multiple system, born together, share it)
export function initEvolution(b, seed, ageYr) {
  const st = b.star; if (!st || b.evo) return;
  const m = (st.mass || b.mass) / C.Msun, life = tMS(m), u = hashf(seed, 7);
  let x0;
  if (st.kind === KIND.GIANT) x0 = 1.01 + 0.07 * u;
  else if (st.kind === KIND.SUPERGIANT) x0 = 1.0 + 0.08 * u;
  else if (st.kind === KIND.MS || st.kind === KIND.BD) x0 = ageYr ? clamp(ageYr / life, 0.002, 0.95) : 0.05 + 0.85 * u;
  else x0 = null;                                    // a remnant already
  // a white dwarf in a system of known age has been cooling since its (more massive) progenitor died
  const wdAge0 = st.kind !== KIND.WD ? 0 : ageYr ? Math.max(1e7, ageYr - tMS(wdProgenitor(m))) : 1e8 + 3e9 * u;
  b.evo = { m, life, x0, L0: b.lum, R0: b.radius, T0: b.temp, cls0: b.cls, kind0: st.kind, wdAge0, phase: '' };
}
// the star's state at t years from now; returns { L (L_sun), R (m), T, m (M_sun), phase, kind, cls }
export function stellarState(b, tyr) {
  const e = b.evo; if (!e) return null;
  const m = e.m;
  if (e.kind0 === KIND.WD) {
    // a white dwarf cooling (Mestel: luminosity falls as age^-7/5, temperature as ~age^-0.35)
    const age = Math.max(e.wdAge0 + tyr, 1e6), T = Math.max(e.T0 * Math.pow(age / e.wdAge0, -0.38), 300);
    return { L: e.L0 * Math.pow(T / e.T0, 4), R: e.R0, T, m, phase: T < 3000 ? 'black dwarf (a cold white dwarf)' : 'white dwarf, cooling', kind: KIND.WD };
  }
  if (e.x0 === null || e.kind0 === KIND.BD && m < 0.08) return { L: e.L0, R: e.R0, T: e.T0, m, phase: '', kind: e.kind0 };
  const x = e.x0 + tyr / e.life;
  if (x < 1) {
    if (x < 0) {
      // rewound before its birth. Pre-main-sequence contraction takes ~50 Myr for the Sun, much less for massive stars;
      // before that the star's gas is still part of a molecular cloud (the last ~20 Myr: a star-forming region)
      const tpre = clamp(0.005 * e.life, 1e5, 5e7), before = -x * e.life;
      if (before > tpre) return { L: 0, R: e.R0, T: e.T0, m, phase: 'not yet formed', kind: e.kind0, unborn: true, nursery: before - tpre < 2e7 ? (before - tpre) / 2e7 : -1 };
      const f = clamp(before / tpre, 0, 1);
      const R = e.R0 * msR(0) / msR(Math.min(e.x0, 0.99)) * (1 + 2 * f), T = Math.min(e.T0, 3000 + 1500 * (1 - f));
      return { L: 4 * Math.PI * R * R * C.sigma * T ** 4 / C.Lsun, R, T, m, phase: 'protostar (still contracting, not yet fusing hydrogen)', kind: KIND.MS };
    }
    const kL = msL(x) / msL(Math.min(e.x0, 0.99)), kR = msR(x) / msR(Math.min(e.x0, 0.99));
    const L = e.L0 * kL, R = e.R0 * kR;
    return { L, R, T: e.T0 * Math.pow(kL / (kR * kR), 0.25), m, phase: 'main sequence (' + Math.round(x * 100) + '% through its hydrogen)', kind: KIND.MS };
  }
  // end of the main sequence relative to now
  // the star at the end of its main sequence, worked back from its present state with the same track
  const x0c = Math.min(e.x0, 0.99), g0 = clamp((e.x0 - 1) / 0.1, 0, 1), kexp = 3.0 * (m < 2 ? 1 : 0.75);
  let Lend, Rend;
  if (e.x0 < 1) { Lend = e.L0 * msL(1) / msL(x0c); Rend = e.R0 * msR(1) / msR(x0c); }
  else if (m >= 8) { Lend = e.L0 / (1 + 0.6 * g0); Rend = e.R0 / Math.pow(10, 2.0 * smooth(g0 * 1.5)); }
  else { Lend = e.L0 / Math.pow(10, kexp * smooth(g0)); Rend = e.R0 / Math.pow(e.L0 / Lend, 0.7); }
  const g = (x - 1) / 0.1;
  if (m >= 8) {
    if (g < 1) {
      // red supergiant: about as luminous, swelling to ~1000 solar radii
      const R = Rend * Math.pow(10, 2.0 * smooth(g * 1.5)), L = Lend * (1 + 0.6 * g);
      return { L, R, T: 5772 * Math.pow(L / Math.pow(R / C.Rsun, 2), 0.25), m, phase: (5772 * Math.pow(L / Math.pow(R / C.Rsun, 2), 0.25) > 7000 ? 'blue' : 'red') + ' supergiant (burning helium and heavier elements)', kind: KIND.SUPERGIANT };
    }
    const tr = (g - 1) * 0.1 * e.life;    // years since the core collapsed
    if (m >= 20) return { L: 0, R: 2 * C.G * 0.4 * m * C.Msun / C.c ** 2, T: 0, m: 0.4 * m, phase: 'black hole (its core collapsed ' + fmtY(tr) + ' ago)', kind: KIND.BH, snrAge: tr };
    const T = Math.max(3e4, 1e6 * Math.pow(1 + tr / 1e5, -0.3));
    return { L: 4 * Math.PI * 12e3 ** 2 * C.sigma * T ** 4 / C.Lsun, R: 12e3, T, m: 1.4, phase: 'neutron star (supernova ' + fmtY(tr) + ' ago)', kind: KIND.NS, snrAge: tr };
  }
  if (g < 1) {
    // subgiant, red giant branch, helium burning, asymptotic giant branch (luminosity up to ~1000x the end of the main sequence)
    const L = Lend * Math.pow(10, kexp * smooth(g)), R = Rend * Math.pow(L / Lend, 0.7);
    return { L, R, T: 5772 * Math.pow(L / Math.pow(R / C.Rsun, 2), 0.25), m: m - (m - wdMass(m)) * smooth(g), phase: g < 0.15 ? 'subgiant (hydrogen exhausted in the core)' : 'red giant', kind: KIND.GIANT };
  }
  // white dwarf: the bare core, cooling (the ejected envelope glows as a planetary nebula for ~10,000 years)
  const mw = wdMass(m), R = 0.0127 * C.Rsun * Math.pow(mw / 0.6, -1 / 3), tc = (g - 1) * 0.1 * e.life + 1e4;
  const T = Math.max(300, Math.min(1.5e5, 2.5e4 * Math.pow(tc / 1e8, -0.38)));
  return { L: 4 * Math.PI * R * R * C.sigma * T ** 4 / C.Lsun, R, T, m: mw, phase: tc < 3e4 ? 'planetary nebula nucleus' : T < 3000 ? 'black dwarf (a cold white dwarf)' : 'white dwarf, cooling', kind: KIND.WD, pnAge: tc };
}
// initial-final mass relation (Cummings et al. 2018, simplified)
export const wdMass = (m) => clamp(0.08 * m + 0.47, 0.5, 1.35);
export const wdProgenitor = (mwd) => clamp((mwd - 0.47) / 0.08, 0.9, 8);
function fmtY(y) { return y < 1e3 ? Math.round(y) + ' years' : y < 1e6 ? Math.round(y / 1e3) + ' thousand years' : y < 1e9 ? (y / 1e6).toFixed(0) + ' million years' : (y / 1e9).toFixed(1) + ' billion years'; }
