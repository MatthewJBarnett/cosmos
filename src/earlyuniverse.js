// The first moments, from inflation to the end of Big Bang nucleosynthesis, computed at load.
//
// Clock: seconds since the Big Bang (t). The rest of the app runs on seconds since J2000, which near the Big Bang
// only resolves ~60 s, so the earliest moments use this clock instead (see nav.early).
//
// - Inflation (1e-36 to 1e-32 s): ~60 e-folds of exponential expansion driven by the inflaton; quantum fluctuations are
//   stretched beyond the horizon and frozen (the seeds of all later structure). It ends in reheating: the inflaton
//   decays into a hot plasma of every particle species.
// - The radiation era: temperature from t = 2.42 g*^-1/2 (T / MeV)^-2 s, with g*(T) counting the relativistic degrees
//   of freedom as species become non-relativistic (top, W, Z, Higgs; the quark-hadron transition; muons; e+-).
// - Below 10 MeV an explicit integration: neutrinos decouple at ~1 MeV; electron-positron annihilation heats the photons
//   (entropy conservation gives T_nu / T = (4/11)^1/3 afterwards); the weak rates n <-> p (Bernstein, Brown & Feinberg
//   1989 integrals, normalised to the neutron lifetime) set the neutron fraction, which freezes out near 0.8 MeV and
//   decays; then a nuclear network (n, p, D, T, 3He, 4He, 7Li, 7Be; 12 reactions with the rate fits of Smith, Kawano &
//   Malaney 1993 / Caughlan & Fowler 1988) builds the light elements once deuterium survives photodissociation.
//   Baryon-to-photon ratio eta = 6.1e-10 (Planck 2018, Omega_b h^2 = 0.0224).

export const T_PLANCK = 5.39e-44;            // s
export const INF_START = 1e-36, INF_END = 1e-32, N_EFOLDS = 60;
const K_MeV = 1.1605e10;                     // K per MeV
const ETA = 6.1e-10, TAU_N = 879.4, Q = 1.2933, ME = 0.511;

// effective relativistic degrees of freedom (energy) vs temperature in GeV (Standard Model)
const GSTAR = [[1e19, 106.75], [300, 106.75], [100, 96.25], [30, 86.25], [5, 86.25], [2, 75.75], [1, 61.75], [0.3, 61.75],
  [0.2, 40], [0.15, 24], [0.12, 17.25], [0.1, 14.25], [0.05, 10.75], [0.002, 10.75], [0.0005, 7.5], [0.00005, 3.36]];
export function gStar(TGeV) {
  if (TGeV >= GSTAR[0][0]) return GSTAR[0][1];
  for (let i = 1; i < GSTAR.length; i++) if (TGeV >= GSTAR[i][0]) {
    const [t1, g1] = GSTAR[i - 1], [t0, g0] = GSTAR[i], f = Math.log(TGeV / t0) / Math.log(t1 / t0);
    return g0 + (g1 - g0) * f;
  }
  return 3.36;
}

// ---------- the nucleosynthesis integration (t from ~0.01 s to 2e4 s) ----------
// e+- energy and entropy relative to their relativistic values, as functions of z = m_e / T
function epm(z) {
  let I = 0, J = 0; const N = 400, xm = 30;
  for (let i = 1; i <= N; i++) {
    const x = (i - 0.5) * xm / N, E = Math.sqrt(x * x + z * z), f = 1 / (Math.exp(E) + 1);
    I += x * x * E * f; J += (x * x * E + x * x * x * x / (3 * E)) * f;
  }
  I *= xm / N; J *= xm / N;
  return { rho: 30 / Math.PI ** 4 * I, s: 22.5 / Math.PI ** 4 * J };      // relative to a_rad T^4 and (4/3) a_rad T^3
}
const EPM = []; for (let k = 0; k <= 400; k++) EPM.push(epm(k * 0.05));    // z = 0 .. 20
const epmAt = (z) => { if (z >= 20) return { rho: 0, s: 0 }; const f = z / 0.05, i = Math.floor(f), u = f - i, a = EPM[i], b = EPM[i + 1]; return { rho: a.rho + (b.rho - a.rho) * u, s: a.s + (b.s - a.s) * u }; };

// weak rates n -> p and p -> n (per second) at photon temperature T and neutrino temperature Tn (MeV)
function weakRates(T, Tn) {
  const q = Q / ME, z = ME / T, zn = ME / Tn;
  const integ = (sgn) => {
    // sgn = +1: n -> p (q); -1: p -> n (-q)
    const qq = sgn * q; let s = 0; const N = 600, em = 1 + 40 / Math.min(z, zn) + 2 * q;
    for (let i = 0; i < N; i++) {
      const e = 1 + (i + 0.5) * (em - 1) / N, w = e * Math.sqrt(e * e - 1);
      s += w * ((e - qq) ** 2 / ((1 + Math.exp(-e * z)) * (1 + Math.exp((e - qq) * zn))) + (e + qq) ** 2 / ((1 + Math.exp(e * z)) * (1 + Math.exp(-(e + qq) * zn))));
    }
    return s * (em - 1) / N;
  };
  // normalisation: the free decay integral (1.636 for q = 2.531)
  let l0 = 0; { const N = 2000; for (let i = 0; i < N; i++) { const e = 1 + (i + 0.5) * (q - 1) / N; l0 += e * Math.sqrt(e * e - 1) * (q - e) ** 2; } l0 *= (q - 1) / N; }
  const K = 1 / (TAU_N * l0);
  return [K * integ(1), K * integ(-1)];
}

// nuclear reaction rates N_A <sigma v> (cm^3 mol^-1 s^-1) as functions of T9
function rates(T9) {
  const t = Math.min(T9, 10), t13 = Math.cbrt(t), t23 = t13 * t13, t12 = Math.sqrt(t), t32 = t * t12, tm23 = 1 / t23, tm32 = 1 / t32;
  const r = {};
  r.npg = 4.742e4 * (1 - 0.850 * t12 + 0.490 * t - 0.0962 * t32 + 8.47e-3 * t * t - 2.80e-4 * t * t32);                               // p(n,g)d
  r.dpg = 2.65e3 * tm23 * Math.exp(-3.720 / t13) * (1 + 0.112 * t13 + 1.99 * t23 + 1.56 * t + 0.162 * t * t13 + 0.324 * t * t23);   // d(p,g)3He
  r.ddn = 3.95e8 * tm23 * Math.exp(-4.259 / t13) * (1 + 0.098 * t13 + 0.765 * t23 + 0.525 * t + 9.61e-3 * t * t13 + 0.0167 * t * t23); // d(d,n)3He
  r.ddp = 4.17e8 * tm23 * Math.exp(-4.258 / t13) * (1 + 0.098 * t13 + 0.518 * t23 + 0.355 * t - 0.010 * t * t13 - 0.018 * t * t23);   // d(d,p)t
  r.tdn = 1.063e11 * tm23 * Math.exp(-4.559 / t13 - (t / 0.0754) ** 2) * (1 + 0.092 * t13 - 0.375 * t23 - 0.242 * t + 33.82 * t * t13 + 55.42 * t * t23) + 8.047e8 * tm23 * Math.exp(-0.4857 / t); // t(d,n)4He
  r.hen = 7.21e8 * (1 - 0.508 * t12 + 0.228 * t);                                                                                     // 3He(n,p)t
  r.hed = 5.021e10 * tm23 * Math.exp(-7.144 / t13 - (t / 0.270) ** 2) * (1 + 0.058 * t13 + 0.603 * t23 + 0.245 * t + 6.97 * t * t13 + 7.19 * t * t23) + 5.212e8 / t12 * Math.exp(-1.762 / t); // 3He(d,p)4He
  { const ta = t / (1 + 0.0495 * t); r.hea = 5.61e6 * ta ** (5 / 6) * tm32 * Math.exp(-12.826 / Math.cbrt(ta)); }                        // 3He(a,g)7Be
  { const ta = t / (1 + 0.1378 * t); r.ta = 3.032e5 * tm23 * Math.exp(-8.090 / t13) * (1 + 0.0516 * t13 + 0.0229 * t23 + 8.28e-3 * t - 3.28e-4 * t * t13 - 3.01e-4 * t * t23) + 5.109e5 * ta ** (5 / 6) * tm32 * Math.exp(-8.068 / Math.cbrt(ta)); } // t(a,g)7Li
  { const ta = t / (1 + 13.076 * t); r.ben = 2.675e9 * (1 - 0.560 * t12 + 0.179 * t - 0.0283 * t32 + 2.214e-3 * t * t - 6.851e-5 * t * t32) + 9.391e8 * ta ** 1.5 * tm32 + 4.467e7 * tm32 * Math.exp(-0.07486 / t); } // 7Be(n,p)7Li
  { const ta = t / (1 + 0.759 * t); r.lip = Math.max(0, 1.096e9 * tm23 * Math.exp(-8.472 / t13) - 4.830e8 * ta ** (5 / 6) * tm32 * Math.exp(-8.472 / Math.cbrt(ta)) + 1.06e10 * tm32 * Math.exp(-30.442 / t)); } // 7Li(p,a)4He
  r.tpg = 2.87e4 * tm23 * Math.exp(-3.87 / t13) * (1 + 0.108 * t13 + 0.466 * t23 + 0.352 * t + 0.07 * t * t13 + 0.083 * t * t23);       // t(p,g)4He
  // photodissociation (detailed balance): d + g -> n + p, 3He + g -> d + p  (per second)
  r.gd = 4.71e9 * t32 * Math.exp(-25.82 / T9) * r.npg;
  r.ghe = 1.63e10 * t32 * Math.exp(-63.75 / T9) * r.dpg;
  for (const k in r) if (!(r[k] > 0)) r[k] = 0;
  return r;
}
// species: 0 n, 1 p, 2 d, 3 t, 4 3He, 5 4He, 6 7Li, 7 7Be  (Y = number per baryon)
const A = [1, 1, 2, 3, 3, 4, 7, 7];
function derivs(Y, T9, rho, lw) {
  const r = rates(T9), [n, p, d, t, h, a, li, be] = Y, f = new Array(8).fill(0);
  const add = (rate, prod, cons) => { for (const i of cons) f[i] -= rate; for (const i of prod) f[i] += rate; };
  // weak interactions
  add(lw[0] * n, [1], [0]); add(lw[1] * p, [0], [1]);
  add(rho * r.npg * n * p, [2], [0, 1]); add(r.gd * d, [0, 1], [2]);
  add(rho * r.dpg * d * p, [4], [2, 1]); add(r.ghe * h, [2, 1], [4]);
  add(rho * r.ddn * d * d / 2, [4, 0], [2, 2]); add(rho * r.ddp * d * d / 2, [3, 1], [2, 2]);
  add(rho * r.tdn * t * d, [5, 0], [3, 2]); add(rho * r.hen * h * n, [3, 1], [4, 0]);
  add(rho * r.hed * h * d, [5, 1], [4, 2]); add(rho * r.hea * h * a, [7], [4, 5]);
  add(rho * r.ta * t * a, [6], [3, 5]); add(rho * r.ben * be * n, [6, 1], [7, 0]);
  add(rho * r.lip * li * p, [5, 5], [6, 1]); add(rho * r.tpg * t * p, [5], [3, 1]);
  return f;
}
function solve(M, b) {
  const n = b.length; for (let i = 0; i < n; i++) M[i] = M[i].slice(); b = b.slice();
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    const d = M[c][c] || 1e-300;
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / d; if (!f) continue; for (let k = c; k < n; k++) M[r][k] -= f * M[c][k]; b[r] -= f * b[c]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let k = i + 1; k < n; k++) s -= M[i][k] * x[k]; x[i] = s / (M[i][i] || 1e-300); }
  return x;
}

let bbnTab = null;
// (computed the first time it is needed: about a second)
export function getBBN() { if (!bbnTab) bbnTab = runBBN(); return bbnTab; }
function runBBN() {
  const G = 6.674e-8, arad = 7.5657e-15, c2 = 8.988e20;
  // start at T = 10 MeV, everything relativistic and in equilibrium; Tnu tracks 1/a exactly afterwards
  const T0 = 10;                                                     // MeV
  const sOf = (T) => 1 + epmAt(ME / T).s;                          // (photons + e+-) entropy / photon entropy
  const Ttot0 = T0 * Math.cbrt(sOf(T0));                            // invariant a T (1 + r)^(1/3)
  const photonT = (Tn) => {                                         // solve (T)^3 (1 + r(T)) = Tn^3 * 2.75
    const target = Tn * Math.cbrt(2.75 / 1.0);
    let T = Tn; for (let i = 0; i < 60; i++) { const T2 = target / Math.cbrt(sOf(T)); if (Math.abs(T2 - T) < 1e-12 * T) { T = T2; break; } T = T2; }
    return T;
  };
  const rhoOf = (T, Tn) => {
    const TK = T * K_MeV, TnK = Tn * K_MeV, z = ME / T;
    return arad * TK ** 4 * (1 + epmAt(z).rho) + 21 / 8 * arad * TnK ** 4;   // erg / cm^3
  };
  const H = (T, Tn) => Math.sqrt(8 * Math.PI * G * rhoOf(T, Tn) / (3 * c2));
  const tab = [];
  let Tn = T0, T = photonT(Tn), t = 1 / (2 * H(T, Tn));
  let Y = [1 / (1 + Math.exp(Q / T)), 1 - 1 / (1 + Math.exp(Q / T)), 0, 0, 0, 0, 0, 0];
  const lnStep = 0.004;        // d ln a per step
  while (T > 0.0025) {
    // advance the scale factor by lnStep: Tn ~ 1/a
    const H0 = H(T, Tn), Tn1 = Tn * Math.exp(-lnStep), T1 = photonT(Tn1), H1 = H(T1, Tn1);
    const dt = lnStep * 0.5 * (1 / H0 + 1 / H1);
    const T9 = T1 * K_MeV / 1e9, rho = 2.06e-5 * (ETA / 6.1e-10) * T9 ** 3, lw = weakRates(T1, Tn1);
    // backward Euler with Newton iterations
    let Yn = Y.slice();
    for (let it = 0; it < 6; it++) {
      const f = derivs(Yn, T9, rho, lw), F = Yn.map((y, i) => y - Y[i] - dt * f[i]);
      const J = [];
      for (let i = 0; i < 8; i++) J.push(new Array(8).fill(0));
      for (let j = 0; j < 8; j++) {
        const h = Math.max(Math.abs(Yn[j]) * 1e-7, 1e-12), Yp = Yn.slice(); Yp[j] += h;   // (the rates are at most quadratic, so a coarse step is exact enough)
        const fp = derivs(Yp, T9, rho, lw);
        for (let i = 0; i < 8; i++) J[i][j] = (i === j ? 1 : 0) - dt * (fp[i] - f[i]) / h;
      }
      const dY = solve(J, F.map(x => -x));
      let mx = 0; for (let i = 0; i < 8; i++) { Yn[i] = Math.max(Yn[i] + dY[i], 0); mx = Math.max(mx, Math.abs(dY[i]) / Math.max(Yn[i], 1e-20)); }
      if (mx < 1e-8) break;
    }
    Y = Yn; Tn = Tn1; T = T1; t += dt;
    tab.push({ t, T: T * K_MeV, Tn: Tn * K_MeV, Y: Y.slice() });
  }
  return tab;
}
// abundances at t (s since the Big Bang): mass fractions X (n, p, D, T, 3He, 4He, 7Li+7Be) and number ratios to hydrogen
export function bbnAt(t) {
  const tab = getBBN(); let Y;
  if (t <= tab[0].t) Y = tab[0].Y; else if (t >= tab[tab.length - 1].t) Y = tab[tab.length - 1].Y;
  else { let lo = 0, hi = tab.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tab[m].t < t) lo = m; else hi = m; }
    const u = Math.log(t / tab[lo].t) / Math.log(tab[hi].t / tab[lo].t); Y = tab[lo].Y.map((y, i) => y + (tab[hi].Y[i] - y) * u); }
  const X = Y.map((y, i) => y * A[i]);
  // (tritium and 7Be decay later into 3He and 7Li: the final ratios count them together)
  return { Y, X, Yp: X[5], DH: Y[2] / Y[1], He3H: (Y[4] + Y[3]) / Y[1], Li7H: (Y[6] + Y[7]) / Y[1], nFrac: Y[0] / (Y[0] + Y[1]) };
}

// ---------- the state of the universe at t seconds after the Big Bang ----------
// temperature (K), scale factor relative to today, and what is happening
export function earlyState(t) {
  t = Math.max(t, T_PLANCK);
  if (t < INF_START) return { phase: 'planck', T: 1.4e32 * Math.sqrt(T_PLANCK / t), efolds: 0 };
  if (t < INF_END) {
    // inflation: exponential expansion; the radiation is diluted away (the temperature is effectively zero)
    const N = N_EFOLDS * Math.log(t / INF_START) / Math.log(INF_END / INF_START);
    return { phase: 'inflation', T: 0, efolds: N, Treh: Treh() };
  }
  let T;
  if (t > 0.0075) { const s = bbnState(t); T = s.T; }
  else {
    // radiation era: t = 2.42 g*^-1/2 (T/MeV)^-2 s, solved for T with the local g*
    let TMeV = Math.sqrt(2.42 / t / Math.sqrt(10.75)); for (let i = 0; i < 6; i++) TMeV = Math.sqrt(2.42 / t / Math.sqrt(gStar(TMeV / 1000)));
    T = TMeV * K_MeV;
  }
  return { phase: 'radiation', T, efolds: N_EFOLDS, gstar: gStar(T / K_MeV / 1000) };
}
const Treh = () => { const TMeV = Math.sqrt(2.42 / INF_END / Math.sqrt(106.75)); return TMeV * K_MeV; };
function bbnState(t) { const tab = getBBN(); if (t >= tab[tab.length - 1].t) { const l = tab[tab.length - 1]; return { T: l.T * Math.sqrt(l.t / t) }; }
  let lo = 0, hi = tab.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tab[m].t < t) lo = m; else hi = m; }
  const u = Math.log(t / tab[lo].t) / Math.log(tab[hi].t / tab[lo].t); return { T: Math.exp(Math.log(tab[lo].T) + (Math.log(tab[hi].T) - Math.log(tab[lo].T)) * u) }; }

// what is going on at t (s): a name, a line of explanation, the particles present, and how big today's observable
// universe (~93 billion light years across) was
export function earlyEra(t) {
  const s = earlyState(t), T = s.T, E = T / K_MeV;            // MeV
  let name, text;
  if (s.phase === 'planck') { name = 'The Planck era'; text = 'quantum gravity: no tested theory applies'; }
  else if (s.phase === 'inflation') { name = 'Inflation'; text = `space doubles every ~10⁻³⁴ s (${s.efolds.toFixed(0)} of ${N_EFOLDS} e-folds); quantum fluctuations are stretched past the horizon and frozen`; }
  else if (t < 1e-30) { name = 'Reheating'; text = 'the inflaton decays into a hot plasma of every particle'; }
  else if (E > 160e3) { name = 'Electroweak unification'; text = 'all Standard Model particles are massless and in equilibrium; the weak and electromagnetic forces are one'; }
  else if (E > 150) { name = 'Quark-gluon plasma'; text = 'the Higgs field has switched on: particles have mass; quarks and gluons roam free'; }
  else if (E > 100) { name = 'The hadron era'; text = 'quarks are bound into protons, neutrons and pions; antimatter annihilates, leaving one particle in a billion'; }
  else if (E > 0.8) { name = 'The lepton era'; text = 'neutrinos, electrons, positrons and photons in equilibrium; neutrons and protons convert into each other'; }
  else if (t > 150 && t < 1500) { name = 'Big Bang nucleosynthesis'; text = 'deuterium survives at last and is built into helium-4 within minutes'; }
  else if (E > 0.07) { name = 'Weak freeze-out'; text = 'neutrinos decouple; neutrons stop being made and start to decay; electron-positron pairs annihilate'; }
  else if (t < 1500) { name = 'Big Bang nucleosynthesis'; text = 'deuterium survives at last and is built into helium-4 within minutes'; }
  else { name = 'The plasma era'; text = 'nuclei, electrons and light, too hot for atoms; the composition is now fixed for hundreds of millions of years'; }
  const sp = [];
  if (s.phase === 'radiation') {
    sp.push('photons');
    if (E > 160e3) sp.push('W, Z, Higgs, all quarks and leptons (massless)');
    else if (E > 150) sp.push('quarks', 'gluons', 'leptons', 'neutrinos', E > 80e3 ? 'W, Z' : '');
    else if (E > 100) sp.push('protons, neutrons', 'pions', 'muons', 'electrons, positrons', 'neutrinos');
    else if (E > 0.05) sp.push('protons, neutrons', 'electrons, positrons', 'neutrinos');
    else sp.push('nuclei (H, He, traces of D, 3He, Li)', 'electrons', 'neutrinos (free-streaming)');
  } else if (s.phase === 'inflation') sp.push('the inflaton field');
  // scale factor: radiation era a = (T_cmb / T)(3.91 / g*s)^(1/3); during inflation a_end e^(N - 60)
  const aOf = (TK) => 2.7255 / TK * Math.cbrt(3.91 / gStar(TK / K_MeV / 1000));
  const aEnd = aOf(Treh());
  const a = s.phase === 'radiation' ? aOf(T) : s.phase === 'inflation' ? aEnd * Math.exp(s.efolds - N_EFOLDS) : aEnd * Math.exp(-N_EFOLDS);
  return { name, text, T, E, phase: s.phase, efolds: s.efolds, species: sp.filter(Boolean), a, size: 8.8e26 * a };   // size in metres
}

// ---------- the first stars (Population III) ----------
// In small dark-matter halos (~10^6 solar masses) at z ~ 30 to 10 (100-600 Myr), primordial gas cools by molecular
// hydrogen and forms single very massive stars: 30-300 solar masses, no metals, ~100,000 K, living 2-6 Myr. Those of
// 140-260 solar masses die as pair-instability supernovae (the whole star is blown apart, ~100x a normal supernova);
// heavier ones collapse straight to black holes; lighter ones end as core-collapse supernovae. Their metals end the
// era: by ~1 Gyr new stars form from enriched gas. Here: slots in comoving 1 Mpc cells (~30 stars alive per Mpc^3 at
// the peak, a few hundred Myr after the Big Bang).
const h1 = (n) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
export const popIIIRate = (tauGyr) => tauGyr < 0.07 || tauGyr > 1.2 ? 0 : Math.exp(-(((tauGyr - 0.32) / 0.17) ** 2));
// point sources around comoving position cam (Mpc) at cosmic age tau (Gyr), scale factor a (1 today); dtYr: frame step
export function popIIIPoints(cam, tauGyr, a, dtYr, out = []) {
  const rate = popIIIRate(tauGyr); if (rate <= 0) return out;
  const ageYr = tauGyr * 1e9, cx = Math.floor(cam[0]), cy = Math.floor(cam[1]), cz = Math.floor(cam[2]);
  for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) for (let z = cz - 1; z <= cz + 1; z++) {
    const cs = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
    for (let k = 0; k < 40; k++) {
      const s = cs * 0.001 + k * 17.31, M = 30 * Math.pow(10, h1(s) * 1.0), life = 3e6 * Math.pow(100 / M, 0.35);
      let cyc = ageYr / life + h1(s + 1), gen = Math.floor(cyc), age = (cyc - gen) * life;
      if (Math.abs(dtYr) > 0.05 * life) { gen = Math.floor(cyc / (Math.abs(dtYr) / life * 40)); age = 0.5 * life; }
      if (h1(s + gen * 3.7 + 2) > rate * 0.8) continue;
      // a different halo each generation, inside the cell
      const p = [x + h1(s + gen + 3), y + h1(s + gen + 4), z + h1(s + gen + 5)];
      const rel = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]], dc = Math.hypot(...rel), d = Math.max(dc * a * 1e6, 1e-6);   // proper pc
      // visual luminosity: hot (~1e5 K) stars put most light in the ultraviolet: M_V ~ -6.5 for 100 solar masses
      let MV = -6.5 - 2.5 * Math.log10(Math.pow(M / 100, 1.3));
      let col = [0.62, 0.72, 1.0], name = 'Population III star (' + Math.round(M) + ' M☉)';
      // its death: a pair-instability supernova (140-260 M_sun, M_V ~ -21 for ~a year), a core-collapse supernova
      // (M_V ~ -17 for months) or silent collapse to a black hole
      const since = age - life * 0.999;
      if (since > 0 && Math.abs(dtYr) < 0.5) {
        const pisn = M > 140 && M < 260, bh = M >= 260, tExp = since * 365.25;
        if (bh) continue;
        MV = (pisn ? -21 : -17) + (tExp < 60 ? 2.5 * Math.max(0, 1 - tExp / 60) : 0.012 * (tExp - 60));
        col = [1, 0.9, 0.8]; name = pisn ? 'Pair-instability supernova' : 'First supernova';
      }
      const m = MV + 5 * Math.log10(d / 10);
      if (m > 14) continue;
      out.push({ dir: rel, color: col, flux: Math.exp(-0.9210340372 * (m + 26.74)), m, name, M });
    }
  }
  return out;
}
