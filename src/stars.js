// Stellar physics: luminosity function, main sequence relations, blackbody colour.
import { C, clamp } from './math.js';

// Local stellar luminosity function: stars / pc^3 / mag at the solar neighbourhood, index = M_V + 8
export const LF_MIN = -8;
export const LF = [2e-10, 2e-9, 1.2e-8, 6e-8, 2.5e-7, 1e-6, 4e-6, 1.6e-5, 1e-4, 3e-4, 6e-4, 1.2e-3, 2e-3, 2.9e-3, 3.4e-3, 3.5e-3, 4e-3,
  5e-3, 7e-3, 1e-2, 1.2e-2, 1.1e-2, 9e-3, 8e-3, 6e-3, 5e-3];
// fraction of each bin that belongs to the young (spiral arm) population
export const YOUNG = [1, 1, 1, 0.95, 0.9, 0.85, 0.75, 0.6, 0.4, 0.3, 0.2, 0.15, 0.1, 0.08, 0.06, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05];

// Main sequence table: [M_V, Teff, mass (Msun), bolometric correction, spectral index (O=0,B=1..M=6, L=7,T=8) + subclass/10]
const MS = [
  [-6.0, 44500, 60, -4.2, 0.3], [-5.7, 41400, 40, -3.9, 0.5], [-4.9, 35900, 23, -3.4, 0.8], [-4.0, 30000, 17.5, -3.0, 1.0], [-2.5, 20600, 8.0, -2.0, 1.3],
  [-1.2, 15200, 5.0, -1.4, 1.5], [-0.25, 11400, 3.4, -0.6, 1.8], [0.65, 9700, 2.6, -0.3, 2.0], [1.9, 8200, 1.9, -0.1, 2.5], [2.7, 7200, 1.6, -0.05, 3.0],
  [3.5, 6440, 1.33, -0.08, 3.5], [4.4, 5920, 1.08, -0.1, 4.0], [4.83, 5772, 1.0, -0.07, 4.2], [5.1, 5660, 0.95, -0.12, 4.5], [5.9, 5240, 0.86, -0.3, 5.0],
  [7.35, 4410, 0.68, -0.7, 5.5], [8.8, 3850, 0.57, -1.3, 6.0], [10.4, 3550, 0.44, -1.9, 6.2], [12.3, 3200, 0.2, -2.7, 6.4], [14.3, 2900, 0.12, -3.3, 6.6],
  [16.5, 2600, 0.09, -4.1, 6.8], [18.5, 2200, 0.075, -5.0, 7.2], [20.5, 1600, 0.06, -6.0, 7.6], [23, 1100, 0.04, -7.0, 8.4], [30, 600, 0.02, -8, 8.9]];

function msInterp(MV) {
  let i = 0; while (i < MS.length - 2 && MS[i + 1][0] < MV) i++;
  const a = MS[i], b = MS[i + 1], t = clamp((MV - a[0]) / (b[0] - a[0]), 0, 1);
  return { T: Math.exp(Math.log(a[1]) + (Math.log(b[1]) - Math.log(a[1])) * t), mass: Math.exp(Math.log(a[2]) + (Math.log(b[2]) - Math.log(a[2])) * t), bc: a[3] + (b[3] - a[3]) * t, sp: a[4] + (b[4] - a[4]) * t };
}
export function bcOfT(T) {
  // generic bolometric correction for giants etc.
  const lt = Math.log10(T);
  if (T > 7500) return -0.1 - 6.5 * Math.pow(lt - Math.log10(7500), 1.7);
  return -0.1 - 9.5 * Math.pow(Math.log10(7500) - lt, 1.75);
}
function spOfT(T) {
  const tb = [[50000, 0], [30000, 1], [9900, 2], [7300, 3], [5950, 4], [5250, 5], [3850, 6], [2300, 7], [1300, 8], [500, 9]];
  for (let i = 0; i < tb.length - 1; i++) if (T >= tb[i + 1][0]) { const t = (Math.log(tb[i][0]) - Math.log(Math.min(T, tb[i][0]))) / (Math.log(tb[i][0]) - Math.log(tb[i + 1][0])); return tb[i][1] + clamp(t, 0, 0.99); }
  return 8.9;
}
const SPL = 'OBAFGKMLTY';
export function spectralName(sp, lum) { const c = Math.min(9, Math.floor(sp)); const sub = Math.min(9, Math.floor((sp - c) * 10)); return SPL[c] + sub + (lum || ''); }

// Star kinds
export const KIND = { MS: 0, GIANT: 1, SUPERGIANT: 2, WD: 3, NS: 4, BH: 5, BD: 6 };

// Deterministically build a star from (absolute visual magnitude, uniform random numbers u1,u2, young flag)
export function makeStar(MV, u1, u2, young) {
  let kind = KIND.MS, T, mass, bc, sp, lumClass = 'V';
  if (MV < -4.5) {
    if (u1 < 0.55 || !young) { kind = KIND.SUPERGIANT; }
  } else if (MV < 1.8) {
    const pg = young ? (MV < -1 ? 0.12 : 0.25) : 1.0;
    if (u1 < pg) kind = KIND.GIANT;
  } else if (MV < 3.5) { if (u1 < 0.12) kind = KIND.GIANT; }
  else if (MV >= 10 && MV < 16) { if (u1 < 0.07) kind = KIND.WD; else if (u1 < 0.0712) kind = KIND.NS; else if (u1 < 0.0716) kind = KIND.BH; }
  else if (MV >= 16) { kind = u1 < 0.1 ? KIND.WD : KIND.BD; if (u1 > 0.995) kind = KIND.NS; }

  if (kind === KIND.MS || kind === KIND.BD) {
    const m = msInterp(MV + (u2 - 0.5) * 0.3); T = m.T; mass = m.mass; bc = m.bc; sp = m.sp;
    if (mass < 0.075) kind = KIND.BD;
  } else if (kind === KIND.GIANT) {
    // red clump / RGB / AGB: cooler when brighter; a few hot horizontal branch stars
    T = clamp(5100 - (1.0 - MV) * 330 + (u2 - 0.5) * 500, 2900, 5600);
    if (u2 > 0.93) T = 7000 + u1 * 30000 % 5000;
    mass = 0.9 + u2 * 2.2; bc = bcOfT(T); sp = spOfT(T); lumClass = MV < -2.5 ? 'II' : (MV > 2.2 ? 'IV' : 'III');
  } else if (kind === KIND.SUPERGIANT) {
    // blue, yellow and red supergiants
    const r = u2;
    if (r < 0.45) T = 12000 + 18000 * (r / 0.45); else if (r < 0.65) T = 5000 + 4500 * ((r - 0.45) / 0.2); else T = 3300 + 900 * ((r - 0.65) / 0.35);
    mass = 12 + 30 * u1; bc = bcOfT(T); sp = spOfT(T); lumClass = MV < -6.5 ? 'Ia' : 'Ib';
  } else if (kind === KIND.WD) {
    T = 4500 * Math.pow(10, u2 * 0.95); mass = 0.5 + 0.5 * u2 * u2; bc = bcOfT(T) * 0.6; sp = spOfT(T); lumClass = '';
  } else if (kind === KIND.NS) { T = 6e5 + 6e5 * u2; mass = 1.2 + 0.9 * u2; bc = 0; sp = 0; lumClass = ''; }
  else { T = 0; mass = 4 + 30 * u2 * u2; bc = 0; sp = 0; lumClass = ''; }

  let L, R;
  if (kind === KIND.NS) { R = (10 + 3 * u1) * 1e3; L = 4 * Math.PI * R * R * C.sigma * Math.pow(T, 4) / C.Lsun; }
  else if (kind === KIND.BH) { R = 2 * C.G * mass * C.Msun / (C.c * C.c); L = 0; }
  else {
    const Mbol = MV + bc; L = Math.pow(10, 0.4 * (4.74 - Mbol));
    R = Math.sqrt(L) / Math.pow(T / C.Tsun, 2) * C.Rsun;
    if (kind === KIND.WD) { R = 0.0126 * Math.pow(mass, -1 / 3) * C.Rsun; L = 4 * Math.PI * R * R * C.sigma * Math.pow(T, 4) / C.Lsun; }
  }
  let cls;
  if (kind === KIND.WD) cls = 'D' + (T > 12000 ? 'A' : T > 7000 ? 'B' : 'C') + Math.min(9, Math.round(50400 / T));
  else if (kind === KIND.NS) cls = 'Neutron star';
  else if (kind === KIND.BH) cls = 'Black hole';
  else cls = spectralName(sp, lumClass);
  return { kind, MV, T, mass: mass * C.Msun, radius: R, lum: L, cls };
}

// Main sequence absolute magnitude for an effective temperature (inverse of the MS table)
function msMVofT(T) {
  for (let i = 0; i < MS.length - 1; i++) {
    const a = MS[i], b = MS[i + 1];
    if (T <= a[1] && T >= b[1]) { const t = (Math.log(a[1]) - Math.log(T)) / (Math.log(a[1]) - Math.log(b[1])); return { MV: a[0] + (b[0] - a[0]) * t, mass: Math.exp(Math.log(a[2]) + (Math.log(b[2]) - Math.log(a[2])) * t) }; }
  }
  return T > MS[0][1] ? { MV: MS[0][0], mass: MS[0][2] } : { MV: MS[MS.length - 1][0], mass: MS[MS.length - 1][2] };
}
// A star from catalogue data: absolute magnitude, effective temperature and (optional) spectral type string
export function starFromCatalog(MV, T, spect) {
  spect = spect || '';
  const ms = msMVofT(T);
  let kind = KIND.MS, lum = 'V';
  const m = /^(sd|D)?([OBAFGKMLTY])(\d?\.?\d*)\s*(Ia\+?|Iab|Ib|III|II|IV|V|VI)?/.exec(spect);
  if (m && m[1] === 'D') kind = KIND.WD;
  else if (m && m[4]) { lum = m[4]; kind = lum.startsWith('I') && !lum.startsWith('IV') ? (lum === 'III' || lum === 'II' ? KIND.GIANT : KIND.SUPERGIANT) : KIND.MS; if (lum === 'III' || lum === 'II') kind = KIND.GIANT; }
  else if (MV < ms.MV - 1.6) { kind = MV < -4.5 ? KIND.SUPERGIANT : KIND.GIANT; lum = MV < -4.5 ? 'Ib' : 'III'; }
  else if (MV > ms.MV + 4.5 && T > 4500) { kind = KIND.WD; lum = ''; }
  const bc = kind === KIND.WD ? bcOfT(T) * 0.6 : bcOfT(T);
  const L = Math.pow(10, 0.4 * (4.74 - (MV + bc)));
  const R = Math.sqrt(L) / Math.pow(T / C.Tsun, 2) * C.Rsun;
  let mass = kind === KIND.MS ? ms.mass : kind === KIND.GIANT ? clamp(Math.pow(L / 50, 0.3), 0.8, 6) : kind === KIND.SUPERGIANT ? clamp(Math.pow(L, 0.3) * 0.6, 8, 60) : 0.6;
  const cls = m ? (m[1] || '') + m[2] + m[3] + (m[1] === 'D' ? '' : (m[4] || lum)) : (kind === KIND.WD ? 'DA' + Math.min(9, Math.round(50400 / T)) : spectralName(spOfT(T), lum));
  return { kind, MV, T, mass: mass * C.Msun, radius: R, lum: L, cls };
}

// Blackbody colour in linear sRGB, normalised so max channel = 1. Based on CIE 1931 fits (Krystek / Kim et al.).
export function bbColor(T) {
  T = clamp(T, 800, 60000);
  let x;
  if (T < 4000) x = -0.2661239e9 / (T * T * T) - 0.2343589e6 / (T * T) + 0.8776956e3 / T + 0.179910;
  else x = -3.0258469e9 / (T * T * T) + 2.1070379e6 / (T * T) + 0.2226347e3 / T + 0.240390;
  let y;
  if (T < 2222) y = -1.1063814 * x * x * x - 1.34811020 * x * x + 2.18555832 * x - 0.20219683;
  else if (T < 4000) y = -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867;
  else y = 3.0817580 * x * x * x - 5.87338670 * x * x + 3.75112997 * x - 0.37001483;
  const Y = 1, X = Y / y * x, Z = Y / y * (1 - x - y);
  let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z, g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z, b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
  r = Math.max(r, 0); g = Math.max(g, 0); b = Math.max(b, 0);
  const m = Math.max(r, g, b);
  return [r / m, g / m, b / m];
}

export const GLSL_BB = `
vec3 bbColor(float T){
  T = clamp(T, 800., 60000.);
  float x = T < 4000. ? -0.2661239e9/(T*T*T) - 0.2343589e6/(T*T) + 0.8776956e3/T + 0.179910
                      : -3.0258469e9/(T*T*T) + 2.1070379e6/(T*T) + 0.2226347e3/T + 0.240390;
  float y = T < 2222. ? -1.1063814*x*x*x - 1.34811020*x*x + 2.18555832*x - 0.20219683 :
            (T < 4000. ? -0.9549476*x*x*x - 1.37418593*x*x + 2.09137015*x - 0.16748867
                       : 3.0817580*x*x*x - 5.87338670*x*x + 3.75112997*x - 0.37001483);
  float X = x/y, Z = (1.-x-y)/y;
  vec3 c = max(vec3(3.2406*X - 1.5372 - 0.4986*Z, -0.9689*X + 1.8758 + 0.0415*Z, 0.0557*X - 0.2040 + 1.0570*Z), 0.);
  return c / max(c.r, max(c.g, c.b));
}`;
