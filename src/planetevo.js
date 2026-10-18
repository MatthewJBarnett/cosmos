// Every planet evolves. A history is computed once per planet, on a grid of ages from its formation to tens of
// billions of years, from its star's luminosity and mass track, and anchored to its present (generated or measured)
// state. Simple, cited physics throughout; the point is that the right things change, at about the right rates.
//
// Atmospheres: volcanic outgassing (Earth-like rate scaled with mass, waning as the interior cools) adds gas; escape
// removes it. Escape is energy-limited (Watson et al. 1981; efficiency 0.15) and switched on by the Jeans parameter at
// the exobase, whose temperature follows the star's XUV output (saturated at 10^-3.3 of its light while young, then
// falling as age^-1.24, Ribas et al. 2005; low-mass stars stay saturated for billions of years) and is held down by
// CO2 cooling. Without a magnetic field the stellar wind also strips ions (Mars today loses ~2 kg/s). Worlds with
// liquid water and weathering keep their CO2 on a thermostat (more when the star was fainter). Thin atmospheres on
// tidally locked worlds can freeze out on the night side.
// Spin: stellar tides slow every planet towards synchronous rotation (k2 / Q = 0.003 for rock, 1e-5 for giants);
// thick atmospheres raise thermal tides that hold the planet at a slow, often retrograde spin instead (Venus).
// Moons migrate under the planet's tides (outward if the planet spins faster than they orbit, inward otherwise),
// until they are torn apart inside the Roche limit or escape. Hot Jupiters spiral into their stars (Q* = 1e6).
// Giant planets contract and cool (radius ~1.5x at 10 Myr, glowing red while younger than ~10-30 Myr). Rocky planets
// start as magma oceans. Magnetic dynamos stop when small cores freeze (Mars ~0.5 Gyr; Earth-sized ones last).
import { clamp } from './math.js';

const G = 6.674e-11, YR = 31557600, ME = 5.972e24, RE = 6.371e6, AU = 1.496e11, MSUN = 1.989e30, KB = 1.380649e-23, AMU = 1.6605e-27;
const F_XUV_EARTH = 4.6e-3;            // W/m^2 at 1 AU from today's Sun
const N = 240;

// the star's XUV output as a fraction of its light: saturated while young, then decaying
export function xuvFraction(ageYr, mStar) {
  const tsat = clamp(1e8 * Math.pow(Math.max(mStar, 0.08), -2.2), 5e7, 8e9);
  return Math.max(5e-4 * Math.pow(Math.max(ageYr, tsat) / tsat, -1.24), 3e-7);
}
// how long a rocky planet's core dynamo runs (Mars ~0.5 Gyr; an Earth lasts longer than the Sun)
const dynamoYr = (mE) => 0.5e9 * Math.pow(Math.max(mE, 1e-3) / 0.107, 1.6);
// e-folding time of volcanic activity: small bodies cool fast (the Moon and Mercury ~1 Gyr, Mars ~1.5, Earth ~3)
const volcYr = (mE) => 3e9 * Math.pow(Math.max(mE, 1e-3), 0.45);

// build the history table. star(tyr) -> { L (Lsun), M (Msun), R (m) } at tyr years from now; ageNow: the system's age
export function buildHistory(b, ageNow, star, opt = {}) {
  const giant = b.surface && b.surface.gen === 'gas', mE = b.mass / ME, R = b.radius, Mp = b.mass;
  const host = opt.host || null;                       // the star the planet orbits (for moons, their planet's star)
  const aNow = opt.aStar || (b.orbit ? b.orbit.a : AU);
  const atmo = opt.atmo || b.atmo, P0 = atmo ? atmo.P : 0, comp = atmo ? atmo.comp : {};
  const co2rich = (comp.CO2 || 0) > 0.5, wet = !!(b.surface && (b.surface.ocean > 0.5 || b.life)) && !giant;
  const g = G * Mp / (R * R), Matm0 = P0 * 4 * Math.PI * R * R / g;
  const s0 = star(0), mStar0 = s0.M;
  // ages: log spaced from 3 Myr to 60 Gyr, with the present exactly on the grid
  const t0 = 3e6, t1 = Math.max(6e10, ageNow * 3), ages = [];
  for (let i = 0; i < N; i++) ages.push(t0 * Math.pow(t1 / t0, i / (N - 1)));
  let iNow = ages.findIndex(t => t >= ageNow); if (iNow < 0) iNow = N - 1; ages[iNow] = ageNow;
  const plates = wet && mE > 0.3;
  const h = { plates, ages, iNow, ageNow, giant, wet, mE, P0, Matm: new Float64Array(N), S: new Float64Array(N), xuv: new Float64Array(N), Texo: new Float64Array(N),
    esc: new Float64Array(N), out: new Float64Array(N), field: new Uint8Array(N), Ts: new Float64Array(N), co2: new Float64Array(N), rot: new Float64Array(N), a: new Float64Array(N), gone: new Uint8Array(N), Rp: new Float64Array(N), Tint: new Float64Array(N), Lstar: new Float64Array(N) };
  // star and orbit through time
  for (let i = 0; i < N; i++) {
    const st = star(ages[i] - ageNow), sc = mStar0 / Math.max(st.M, 0.05);        // mass loss widens orbits
    const aA = aNow * sc / AU;
    h.S[i] = st.L / (aA * aA); h.Lstar[i] = st.L;
    h.xuv[i] = 1361 * h.S[i] * xuvFraction(ages[i], st.M);          // W/m^2
  }
  // ---- atmosphere (rocky bodies) ----
  if (!giant) {
    const mol = co2rich ? 44 : 28, eps = 0.15;
    const rateAt = (i, Matm) => {
      const xr = h.xuv[i] / F_XUV_EARTH;
      const cool = co2rich ? 0.35 : (comp.CO2 || 0) > 0.05 ? 0.6 : 1;
      const Teq = 278.6 * Math.pow(h.S[i] * 0.7, 0.25);
      const Texo = Teq + 900 * Math.pow(xr, 0.7) * cool * (Matm > 0 ? 1 : 0.2);
      // Jeans parameter for atomic O (or the heavy molecule's fragments)
      const lam = G * Mp * 16 * AMU / (KB * Texo * R);
      const eff = 1 / (1 + Math.exp((lam - 6) / 1.4));
      let esc = eps * Math.PI * R * R * R * h.xuv[i] / (G * Mp) * eff;            // kg/s, energy-limited times efficiency
      const field = opt.field !== undefined ? (opt.field === 'never' ? 0 : ages[i] < (opt.field === 'always' ? 1e30 : dynamoYr(mE))) : ages[i] < dynamoYr(mE);
      if (!field) esc += (opt.strip || 8) * Math.pow(xr, 2.5) * Math.pow(R / 3.39e6, 2);              // ion pickup, sputtering and photochemical escape, steeply rising with EUV (Mars today ~1-3 kg/s, MAVEN)
      // outgassing from formation on (Earth today ~8,000 kg/s of CO2): plate tectonics needs water and size; a stagnant
      // lid lets out ~1% as much; on wet worlds weathering takes most of it back out of the air
      const plates = wet && mE > 0.3, regime = opt.outgas !== undefined ? opt.outgas : plates ? 0.05 : 0.01;
      const out = 3.6e4 * mE * regime * Math.exp(-ages[i] / volcYr(mE));
      return { esc, out, Texo, field };
    };
    h.Matm[iNow] = Matm0;
    // forward from now
    for (let i = iNow; i < N; i++) {
      const r = rateAt(i, h.Matm[i]); h.esc[i] = r.esc; h.out[i] = r.out; h.Texo[i] = r.Texo; h.field[i] = r.field ? 1 : 0;
      if (i + 1 < N) h.Matm[i + 1] = Math.max(0, h.Matm[i] + (r.out - r.esc) * (ages[i + 1] - ages[i]) * YR);
    }
    // backward from now (escape put back, outgassing taken out); capped at 200x today's or a 300 bar ceiling
    const cap = Math.max(Matm0 * 200, 0) || 0, ceil = 3e7 * 4 * Math.PI * R * R / g;
    for (let i = iNow; i > 0; i--) {
      const r = rateAt(i - 1, h.Matm[i]); h.esc[i - 1] = r.esc; h.out[i - 1] = r.out; h.Texo[i - 1] = r.Texo; h.field[i - 1] = r.field ? 1 : 0;
      h.Matm[i - 1] = clamp(h.Matm[i] - (r.out - r.esc) * (ages[i] - ages[i - 1]) * YR, 0, Math.min(cap || ceil, ceil));
    }
    // wet worlds: the weathering thermostat (more CO2 when the star was fainter, Walker et al. 1981)
    for (let i = 0; i < N; i++) h.co2[i] = wet ? clamp(Math.exp(-(h.S[i] - h.S[iNow]) / (0.035 * h.S[iNow])), 1e-3, 3e3) : 1;
  }
  // ---- surface temperature ----
  for (let i = 0; i < N; i++) {
    const P = giant ? 0 : h.Matm[i] * g / (4 * Math.PI * R * R);
    const Teq = 278.6 * Math.pow(h.S[i] * (1 - (b.albedo || 0.3)), 0.25);
    const gh = Math.min(450, 33 * Math.pow(P / 1e5, 0.45)) * (Teq > 200 ? 1 : 0.3);
    h.Ts[i] = Teq + gh;
  }
  // ---- spin ----
  const rot0 = b.rotPeriod || 86400, orbP = b.orbit && b.orbit.period ? b.orbit.period : 3.15e7, n = 2 * Math.PI / orbP;
  const locked0 = Math.abs(Math.abs(rot0) - orbP) < orbP * 0.02, moon = !!opt.isMoon;
  for (let i = 0; i < N; i++) h.rot[i] = rot0;
  if (!locked0 && !moon && b.orbit) {
    const kq = giant ? 1e-5 : 3e-3, Mst = mStar0 * MSUN;
    const k = 1.5 / 0.33 * kq * (Mst / Mp) * Math.pow(R / aNow, 3) * n * n;         // rad/s^2
    const w0 = 2 * Math.PI / rot0;
    const thick = !giant && P0 > 2e6;                                                    // > 20 bar: thermal tides
    const wEq = thick ? -n / 1.08 : n;                                                   // Venus: -243 d against a 225 d year
    for (let i = 0; i < N; i++) {
      const dt = (ages[i] - ageNow) * YR;
      let w = w0 - Math.sign(w0 - wEq) * k * dt;
      // (never past the equilibrium going forward; going back, no faster than ~2 hours)
      if (dt > 0 && Math.sign(w - wEq) !== Math.sign(w0 - wEq)) w = wEq;
      w = clamp(w, -2 * Math.PI / 7200, 2 * Math.PI / 7200);
      h.rot[i] = Math.abs(w) < 1e-12 ? 1e12 : 2 * Math.PI / w;
    }
  }
  // ---- orbit: hot Jupiters (and anything close) spiral in through the star's tides ----
  for (let i = 0; i < N; i++) h.a[i] = aNow;
  if (!moon && b.orbit && s0.R) {
    const Rs = s0.R, Q = 1e6, Mst = mStar0 * MSUN;
    const K = 117 / 4 * Math.sqrt(G / Mst) * Math.pow(Rs, 5) * Mp / Q;              // d(a^13/2)/dt
    const a13 = Math.pow(aNow, 6.5);
    for (let i = 0; i < N; i++) {
      const v = a13 - K * (ages[i] - ageNow) * YR;
      h.a[i] = v > 0 ? Math.pow(v, 1 / 6.5) : 0;
      if (h.a[i] < 1.6 * Rs) h.gone[i] = 1;
    }
  }
  // ---- giant planets contract and cool; rocky ones start molten ----
  for (let i = 0; i < N; i++) {
    const gfun = (t) => 1 + 0.5 * Math.pow(t / 1e7, -0.4);
    h.Rp[i] = giant ? R * gfun(ages[i]) / gfun(ageNow) : R;
    const TintNow = giant ? 100 * Math.pow(Math.max(mE / 318, 0.03), 0.4) : 0;
    h.Tint[i] = giant ? TintNow * Math.pow(ages[i] / ageNow, -0.32) : ages[i] < 6e7 * Math.sqrt(Math.max(mE, 0.01)) ? 1500 * clamp(1 - ages[i] / (6e7 * Math.sqrt(Math.max(mE, 0.01))), 0, 1) + 300 : 0;
  }
  return h;
}

// interpolated state at age t (years)
export function historyAt(h, age) {
  const A = h.ages; let i = 0;
  if (age <= A[0]) i = 0; else if (age >= A[N - 1]) i = N - 2; else { let lo = 0, hi = N - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A[m] <= age) lo = m; else hi = m; } i = lo; }
  const u = clamp((age - A[i]) / (A[i + 1] - A[i]), 0, 1), L = (k) => h[k][i] + (h[k][i + 1] - h[k][i]) * u;
  return { i, u, Matm: L('Matm'), S: L('S'), xuv: L('xuv'), esc: L('esc'), out: L('out'), Ts: L('Ts'), co2: L('co2'), rot: L('rot'), a: L('a'), gone: h.gone[i + (u > 0.5 ? 1 : 0)], Rp: L('Rp'), Tint: L('Tint'), field: h.field[i + (u > 0.5 ? 1 : 0)], Texo: L('Texo') };
}

// moons migrating under their planet's tides: semi-major axis at t years from now, or null once gone
export function moonA(moon, planet, tyr) {
  const a0 = moon.orbit.a, Mp = planet.mass, m = moon.mass, Rp = planet.radius;
  const giant = planet.surface && planet.surface.gen === 'gas', kq = giant ? 1e-5 : 3e-3;
  const wp = planet.rotPeriod ? 2 * Math.PI / planet.rotPeriod : 0, n = 2 * Math.PI / moon.orbit.period;
  const s = wp > n ? 1 : -1;
  const K = 6.5 * 3 * kq * (m / Mp) * Math.pow(Rp, 5) * Math.sqrt(G * Mp);
  const v = Math.pow(a0, 6.5) + s * K * tyr * YR;
  if (v <= 0) return null;
  const a = Math.pow(v, 1 / 6.5);
  const roche = 2.44 * Rp * Math.cbrt((Mp / (4.19 * Rp ** 3)) / Math.max(m / (4.19 * moon.radius ** 3), 300));
  return { a, gone: a < roche ? 'torn apart into a ring' : a > 3 * a0 * 50 ? 'escaped' : null, s };
}

// ---- apply to a system's bodies at time tyr (years from now) ----
// starFn(tyr) -> { L, M, R }; ageNow: the system's present age; skip(b): bodies with their own models (Earth, Pluto...)
export function evolveBodies(sys, tyr, ageNow, starFn, skip, optFor, noOrbit) {
  const age = ageNow + tyr;
  const visit = (b, host) => {
    if (b.kind === 'star' || b.kind === 'comet' || b.kind === 'barycenter' || !b.mass || !b.radius || (skip && skip(b))) { for (const c of b.children || []) visit(c, host); return; }
    const isMoon = b.parent && b.parent.kind !== 'star' && b.parent.kind !== 'barycenter';
    if (!b.hist) {
      if (b._r0 === undefined) { b._r0 = b.radius; b._rot0 = b.rotPeriod; b._a0 = b.orbit ? b.orbit.a : 0; b._p0 = b.orbit ? b.orbit.period : 0; b._temp0 = b.temp; }
      const o = Object.assign({ isMoon, aStar: isMoon && b.parent.orbit ? b.parent.orbit.a : undefined }, optFor ? optFor(b) : {});
      b.hist = buildHistory(Object.assign({}, b, { radius: b._r0, rotPeriod: b._rot0 }), ageNow, starFn, o);
    }
    const s = historyAt(b.hist, age); b.evoNow = s; b.evoAge = age;
    const giant = b.hist.giant;
    // atmosphere: thickness relative to the generated (present) state, in steps so the scattering tables rebuild rarely
    if (b.atmo && !giant && b.hist.P0 > 0) {
      const g = 6.674e-11 * b.mass / (b._r0 * b._r0), P = s.Matm * g / (4 * Math.PI * b._r0 * b._r0);
      b.atmoK = clamp(P / b.hist.P0, 1e-3, 30); b.evoP = P;
      // a thin atmosphere on a tidally locked world freezes out on the night side
      if (b._rot0 && b._p0 && Math.abs(Math.abs(b._rot0) - b._p0) < b._p0 * 0.02 && P < 3e4 && s.Ts < 260) { b.atmoK *= 0.05; b.evoCollapsed = true; } else b.evoCollapsed = false;
    }
    // (temperatures anchored to the body's actual present value: the simple greenhouse is only used for changes)
    if (b.hist.Ts && !giant && !b.precessRA && b._temp0) { const T = Math.max(3, s.Ts + b._temp0 - b.hist.Ts[b.hist.iNow]); b.temp = T; b.meanT = T; }
    if (!isMoon && b._rot0) b.rotPeriod = s.rot;
    // orbit: hot Jupiters spiral in
    if (!noOrbit && !isMoon && b.orbit && b._a0 && s.a !== b._a0) {
      const k = s.a / b._a0; if (Math.abs(k - 1) > 1e-6) { b.orbit.a = s.a; b.orbit.period = b._p0 * Math.pow(k, 1.5); }
      if (s.gone) b.evoGone = 'spiralled into its star';
    }
    // moons migrate
    if (!noOrbit && isMoon && b.orbit && b._a0) {
      const m = moonA(Object.assign({}, b, { orbit: { a: b._a0, period: b._p0 } }), b.parent, tyr);
      if (!m) b.evoGone = 'torn apart into a ring'; else { b.orbit.a = m.a; b.orbit.period = b._p0 * Math.pow(m.a / b._a0, 1.5); b.evoGone = m.gone; b.evoMig = m.s; }
    }
    // giants contract and glow while young; rocky planets begin molten
    if (giant) { b.radius = s.Rp; }
    const glow = s.Tint > 650 ? s.Tint : 0;
    if (glow) { b.heatT = Math.max(b.heatT || 0, glow); b._evoGlow = glow; } else if (b._evoGlow) { if (b.heatT === b._evoGlow) b.heatT = 0; b._evoGlow = 0; }
    for (const c of b.children || []) visit(c, host);
  };
  for (const c of sys.root.children) visit(c, sys.root);
}
