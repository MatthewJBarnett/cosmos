// Long-term evolution of the Sun, the planets' orbits, Earth and the Moon.
// Sun: a solar-mass evolutionary track (after Sackmann, Boothroyd & Kraemer 1993 and Schroeder & Smith 2008):
// main sequence brightening, subgiant, red giant branch to a tip of ~2,700 L_sun and ~1.2 AU, the helium flash,
// horizontal branch, asymptotic giant branch with thermal pulses, ejection of a planetary nebula and a cooling
// carbon-oxygen white dwarf of 0.54 M_sun. Mass loss widens planetary orbits (a * M = const for slow loss).
import { clamp } from './math.js';
import { earthOrbitAt, earthOrbitGrid } from './ephem.js';

export const SUN_AGE_NOW = 4.57;   // Gyr at J2000
// [age Gyr, L/Lsun, R/Rsun, M/Msun]
const TRACK = [
  [0.0, 0.70, 0.89, 1.0], [1.0, 0.75, 0.90, 1.0], [2.0, 0.81, 0.92, 1.0], [3.0, 0.87, 0.94, 1.0], [4.0, 0.95, 0.97, 1.0], [4.57, 1.0, 1.0, 1.0],
  [5.5, 1.09, 1.04, 1.0], [6.5, 1.20, 1.09, 1.0], [7.5, 1.33, 1.16, 1.0], [8.5, 1.51, 1.26, 1.0], [9.5, 1.77, 1.42, 0.999], [10.0, 1.95, 1.54, 0.999],
  [10.9, 2.3, 2.0, 0.998], [11.6, 2.7, 2.4, 0.996], [11.9, 3.6, 3.4, 0.994], [12.0, 6.0, 5.0, 0.99], [12.06, 14, 9, 0.985], [12.1, 34, 17, 0.97],
  [12.13, 110, 33, 0.94], [12.15, 330, 65, 0.88], [12.16, 900, 115, 0.8], [12.165, 1800, 185, 0.72], [12.167, 2730, 256, 0.668],
  // helium flash: the core expands, the envelope shrinks; quiet helium burning on the horizontal branch
  [12.1675, 300, 60, 0.668], [12.169, 60, 14, 0.668], [12.172, 41, 9.5, 0.668], [12.25, 44, 10, 0.667], [12.29, 52, 12, 0.666],
  // asymptotic giant branch, thermal pulses and heavy mass loss
  [12.31, 90, 22, 0.664], [12.33, 260, 55, 0.66], [12.345, 900, 110, 0.64], [12.355, 2500, 165, 0.6], [12.36, 4000, 190, 0.56],
  [12.3602, 4100, 200, 0.545],
  // post-AGB: the bare core contracts at nearly constant luminosity, heating to ~100,000 K in about ten thousand
  // years and lighting the ejected shell as a planetary nebula, then fades onto the white dwarf cooling track
  [12.360203, 4000, 15, 0.542], [12.360206, 3900, 1.5, 0.541], [12.36021, 3600, 0.4, 0.54], [12.36023, 2000, 0.08, 0.54],
  [12.3603, 300, 0.03, 0.54], [12.3606, 60, 0.02, 0.54], [12.362, 10, 0.016, 0.54], [12.37, 2, 0.0135, 0.54], [12.4, 0.6, 0.0128, 0.54],
  [12.6, 0.08, 0.0126, 0.54], [13.5, 0.01, 0.0125, 0.54],
  [16, 0.0015, 0.0125, 0.54], [25, 2.5e-4, 0.0125, 0.54], [60, 3e-5, 0.0125, 0.54], [200, 2e-6, 0.0125, 0.54], [1000, 5e-8, 0.0125, 0.54],
  [1e5, 1e-12, 0.0125, 0.54],
];
export const PN_START = 12.3602, WD_START = 12.3603, RGB_TIP = 12.167;
const ageOf = (tyr) => SUN_AGE_NOW + tyr / 1e9;
function interp(age) {
  // before the Sun: a contracting protostar (Hayashi track), then nothing at all before the cloud collapsed
  if (age < 0) { const f = Math.min(1, -age / 0.05); return [age, 0.7 + 3 * f, 0.89 + 3 * f, 1.0]; }
  if (age <= TRACK[0][0]) return TRACK[0];
  for (let i = 1; i < TRACK.length; i++) {
    const b = TRACK[i]; if (age > b[0]) continue;
    const a = TRACK[i - 1], f = (age - a[0]) / (b[0] - a[0]);
    // luminosity and radius change by orders of magnitude: interpolate in log
    return [age, Math.exp(Math.log(a[1]) + (Math.log(b[1]) - Math.log(a[1])) * f), Math.exp(Math.log(a[2]) + (Math.log(b[2]) - Math.log(a[2])) * f), a[3] + (b[3] - a[3]) * f];
  }
  return TRACK[TRACK.length - 1];
}
export function sunState(tyr) {
  const age = ageOf(tyr), [, L, R, M] = interp(age);
  const T = 5772 * Math.pow(L / (R * R), 0.25);
  const phase = age < 10.0 ? 'Main sequence (G2V)' : age < 11.6 ? 'Subgiant' : age < RGB_TIP ? 'Red giant' : age < 12.172 ? 'Helium flash' : age < 12.3 ? 'Horizontal branch (core helium burning)' : age < PN_START ? 'Asymptotic giant branch' : age < WD_START ? 'Post-AGB star (nucleus of a planetary nebula)' : 'White dwarf';
  return { age, L, R, M, T, phase };
}
// planetary orbits widen as the Sun loses mass (adiabatic: a M = const)
export function orbitScale(tyr) { return 1 / interp(ageOf(tyr))[3]; }
// planets swallowed by the giant Sun (Mercury and Venus certainly; Earth very likely through tidal drag)
const AU_RSUN = 215.03;
export function engulfed(name, tyr) {
  const age = ageOf(tyr);
  // before the planets formed (the first tens of millions of years) there is only the young Sun and its disk
  if (age < 0.03 || (name === 'Moon' && age < 0.07)) return true;
  if (age < 12.1) return false;
  if (name === 'Earth' || name === 'Moon') return age >= RGB_TIP - 0.0005;
  const a0 = { Mercury: 0.387, Venus: 0.723 }[name]; if (!a0) return false;
  // once inside the envelope they never come back
  let maxR = 0; for (const row of TRACK) { if (row[0] > age) break; maxR = Math.max(maxR, row[2] / AU_RSUN / (a0 / row[3])); }
  return Math.max(maxR, interp(age)[2] / AU_RSUN / (a0 * orbitScale(tyr))) > 0.85;
}
// the planetary nebula: ejected at ~20 km/s at the end of the AGB, lit once the core is hotter than ~30,000 K
export function planetaryNebula(tyr) {
  const age = ageOf(tyr); if (age < PN_START || age > PN_START + 6e-5) return null;
  const t = (age - PN_START) * 1e9;     // years since ejection
  const r = 20e3 * t * 3.156e7;           // m
  const s = sunState(tyr);
  const lit = clamp((s.T - 25000) / 20000, 0, 1) * clamp(1 - (t - 3.5e4) / 2.5e4, 0, 1);
  return { t, r, lit };
}

// ---- Earth and Moon ----
// Tidal recession: da/dt ~ a^(-11/2) gives a = a0 (1 + k t)^(2/13), with today's 3.82 cm/yr. Tidal friction was
// weaker in the past (ocean resonance), so the backwards extrapolation is damped.
const A_MOON = 384400e3, K_REC = 6.5 * 0.0382 / A_MOON;
export function moonScale(tyr) {
  const k = tyr >= 0 ? K_REC : K_REC * 0.3;
  return Math.max(0.55, Math.pow(Math.max(1 + k * tyr, 0.02), 2 / 13));
}
// length of the sidereal day from conservation of angular momentum of the Earth-Moon system
const I_E = 8.04e37, W0 = 7.2921159e-5, MU = 5.972e24 * 7.342e22 / (5.972e24 + 7.342e22), GM_EM = 6.674e-11 * (5.972e24 + 7.342e22);
const L_TOT = I_E * W0 + MU * Math.sqrt(GM_EM * A_MOON);
export function earthDay(tyr) {
  const a = A_MOON * moonScale(tyr), w = (L_TOT - MU * Math.sqrt(GM_EM * a)) / I_E;
  return 2 * Math.PI / Math.max(w, 1e-7) * (86164.0905 / (2 * Math.PI / W0));
}
// axial precession (25,772 yr) and the 41,000 yr obliquity cycle (amplitude simplified from Laskar 2004)
const P_PREC = 50.29 / 3600 * Math.PI / 180;    // rad/yr
export function obliquity(tyr) { return (23.3 + 1.2 * Math.cos(1.4537 + 2 * Math.PI * tyr / 41040)) * Math.PI / 180; }
export function earthPole(tyr) {
  const lam = Math.PI / 2 - P_PREC * tyr, beta = Math.PI / 2 - obliquity(tyr);
  return [Math.cos(beta) * Math.cos(lam), Math.sin(beta), -Math.cos(beta) * Math.sin(lam)];
}
// what the brightening Sun does to Earth: insolation relative to today, oceans evaporating (moist greenhouse,
// ~1-1.5 Gyr), the biosphere failing, and finally a surface hot enough to glow
export function earthClimate(tyr) {
  const s = sunState(tyr), a = orbitScale(tyr), S = s.L / (a * a);
  const dry = clamp((S - 1.09) / 0.12, 0, 1), life = 1 - clamp((S - 1.05) / 0.06, 0, 1);
  const Teq = 255 * Math.pow(S, 0.25) * (dry > 0.5 ? 1.25 : 1);     // with a thick steam / CO2 greenhouse
  const ice = 1 - clamp((S - 1.02) / 0.05, 0, 1);
  // the deep past: land plants spread from ~470 Myr ago (forests ~385 Myr): before that the continents are bare rock
  // and soil; the Cryogenian "Snowball Earth" glaciations (~717-660 and ~650-635 Myr ago) froze the planet to the
  // equator; in its first ~100 Myr the surface was a magma ocean
  const landLife = clamp((tyr + 4.7e8) / 8.5e7, 0, 1);
  const snowball = tyr > -7.17e8 && tyr < -6.35e8 && !(tyr > -6.6e8 && tyr < -6.5e8) ? 1 : 0;
  const magma = clamp((-4.47e9 - tyr) / 3e7, 0, 1);
  return { S, dry, life: life * landLife, Teq, ice, glow: clamp((Teq - 900) / 900, 0, 1), snowball, magma };
}
export function planetTeq(name, tyr, albedo = 0.3, aAU) {
  const s = sunState(tyr), a = aAU * orbitScale(tyr);
  return 278.6 * Math.pow(s.L * (1 - albedo) / (a * a), 0.25);
}

// ---- ice ages ----
// Milankovitch forcing: midsummer daily insolation at 65 N from the orbit (eccentricity and perihelion from the
// secular theory, precession of the equinoxes, obliquity). Ice volume follows the Imbrie & Imbrie (1980) model:
// it relaxes towards the forcing, growing slowly (~42,000 yr) and melting fast (~10,600 yr). Northern ice sheets
// began ~2.7 million years ago; the cycles were smaller before the mid-Pleistocene transition (~1 Myr ago).
// Human CO2 is expected to delay the next glaciation by ~50,000-100,000 yr (Berger & Loutre 2002, Ganopolski et
// al. 2016): growth is held off for the first 50,000 years.
export function insolation65(tyr, orb) {
  const { e, varpi } = orb || earthOrbitAt(tyr);
  // longitude of perigee of the Sun measured from the moving equinox
  const wq = (varpi + 180) * Math.PI / 180 + P_PREC * tyr, eps = obliquity(tyr), phi = 65 * Math.PI / 180;
  const rr = (1 + e * Math.cos(Math.PI / 2 - wq)) / (1 - e * e);          // a/r at the June solstice
  const H0 = Math.acos(clamp(-Math.tan(phi) * Math.tan(eps), -1, 1));
  return 1361 / Math.PI * rr * rr * (H0 * Math.sin(phi) * Math.sin(eps) + Math.cos(phi) * Math.cos(eps) * Math.sin(H0));
}
const ICE_T0 = -3.0e6, ICE_T1 = 10e6, ICE_DT = 500;
let iceTab = null, iceRef = null;
function iceInit() {
  const n = Math.round((ICE_T1 - ICE_T0) / ICE_DT) + 1;
  const Q = new Float32Array(n), G = earthOrbitGrid(ICE_T0, ICE_DT, n); let m = 0;
  for (let i = 0; i < n; i++) { Q[i] = insolation65(ICE_T0 + i * ICE_DT, { e: G.E[i], varpi: G.W[i] }); m += Q[i]; }
  m /= n; let sd = 0; for (let i = 0; i < n; i++) sd += (Q[i] - m) ** 2; sd = Math.sqrt(sd / n);
  iceTab = new Float32Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    const t = ICE_T0 + i * ICE_DT;
    let x = -(Q[i] - m) / sd;
    if (t > 0 && t < 5e4) x = Math.min(x, v);            // anthropogenic CO2: no new ice for now
    const tau = 17000 / (x > v ? 1 - 0.6 : 1 + 0.6);     // grows slowly, melts fast
    v += (x - v) * ICE_DT / tau;
    iceTab[i] = v;
  }
  // calibrate: today's interglacial is 0, the Last Glacial Maximum (~21,000 yr ago) is 1 (sea level -125 m)
  const at = (t) => iceTab[Math.round((t - ICE_T0) / ICE_DT)];
  let lgm = -1e9; for (let t = -30000; t <= -15000; t += ICE_DT) lgm = Math.max(lgm, at(t));
  iceRef = [at(0), lgm];
}
// ice volume relative to the Last Glacial Maximum (0 = today, 1 = LGM)
export function iceAge(tyr) {
  if (tyr < ICE_T0 || tyr > ICE_T1 - 1) return 0;
  if (!iceTab) iceInit();
  const f = (tyr - ICE_T0) / ICE_DT, i = Math.floor(f), w = f - i;
  const v = iceTab[i] * (1 - w) + iceTab[Math.min(i + 1, iceTab.length - 1)] * w;
  let ice = clamp((v - iceRef[0]) / (iceRef[1] - iceRef[0]), 0, 1.2);
  ice *= clamp((tyr + 2.9e6) / 3e5, 0, 1) * (tyr < -1.2e6 ? 0.55 : tyr < -0.8e6 ? 0.55 + 0.45 * (tyr + 1.2e6) / 4e5 : 1);
  return ice * clamp((ICE_T1 - tyr) / 3e6, 0, 1);
}
// the first time after t0 when the ice sheets pass a given fraction of their last-glacial-maximum volume
export function nextGlacial(t0, level = 0.5) { for (let t = t0; t < ICE_T1; t += ICE_DT) if (iceAge(t) >= level) return t; return null; }
