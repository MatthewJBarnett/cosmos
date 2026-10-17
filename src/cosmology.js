// Expanding universe: flat Lambda-CDM (Planck 2018: H0 = 67.7 km/s/Mpc, Omega_m = 0.31, Omega_L = 0.69).
// Galaxies outside the Local Group sit at fixed comoving distances. What an observer in the Milky Way sees at time
// t is light emitted at a_e where the conformal distance travelled equals the comoving distance: images shrink
// (angular diameter distance), dim with (1+z)^4 in surface brightness, redden, and freeze as each galaxy
// crosses our event horizon; in a few hundred billion years nothing beyond the Local Group remains visible.
import { gl } from './gl.js';

export const H0 = 67.7, OM = 0.31, OL = 0.69, T0_GYR = 13.79, CMB0 = 2.7255;
const C_KMS = 299792.458, DH = C_KMS / H0;          // Hubble distance, Mpc
const HGYR = H0 / 977.792;                          // H0 in 1/Gyr
const K = Math.cbrt(OM / OL), W = 1.5 * Math.sqrt(OL) * HGYR;
// scale factor at cosmic time tau (Gyr since the Big Bang); a(T0) = 1
export function aOfTau(tau) {
  const x = W * Math.max(tau, 1e-6);
  // (exponential expansion overflows a double after ~10^13 years: cap it, the visible universe is empty long before)
  return Math.min(1e300, x > 300 ? K * Math.exp((2 / 3) * (Math.min(x, 1000) - Math.LN2)) : K * Math.pow(Math.sinh(x), 2 / 3));
}
export function tauNow() { return T0_GYR; }
const Hof = (a) => Math.sqrt(OM / (a * a * a) + OL);   // in units of H0
// u(a) = comoving distance light still travels after scale factor a (eta_inf - eta(a)), in Mpc
// tabulated on a log grid of a, then inverted on a log grid of u
const NA = 4000, LA0 = Math.log(1e-4), LA1 = Math.log(1e12);
const uOfLa = new Float64Array(NA);
{
  // integrate d(eta) = DH da / (a^2 H(a)) from the far future back
  let u = 0;
  // tail beyond a = 1e12: DH / (a sqrt(OL))
  u = DH / (Math.exp(LA1) * Math.sqrt(OL));
  uOfLa[NA - 1] = u;
  for (let i = NA - 2; i >= 0; i--) {
    const la0 = LA0 + (LA1 - LA0) * i / (NA - 1), la1 = LA0 + (LA1 - LA0) * (i + 1) / (NA - 1);
    const f = (la) => { const a = Math.exp(la); return DH / (a * Hof(a)); };   // d eta / d ln a
    u += (la1 - la0) * (f(la0) + 4 * f((la0 + la1) / 2) + f(la1)) / 6;
    uOfLa[i] = u;
  }
}
export function uOfA(a) {
  const x = (Math.log(a) - LA0) / (LA1 - LA0) * (NA - 1);
  if (x <= 0) return uOfLa[0]; if (x >= NA - 1) return DH / (a * Math.sqrt(OL));
  const i = Math.floor(x), f = x - i; return uOfLa[i] * (1 - f) + uOfLa[i + 1] * f;
}
// inverse table: ln a as a function of ln u
const NU = 1024, LU0 = Math.log(1e-8), LU1 = Math.log(uOfLa[0] * 0.999);
export const laOfLu = new Float32Array(NU);
{
  let j = NA - 1;
  for (let k = 0; k < NU; k++) {
    const lu = LU0 + (LU1 - LU0) * k / (NU - 1), u = Math.exp(lu);
    while (j > 0 && uOfLa[j - 1] < u) j--;
    // u decreases with a: find i with uOfLa[i] >= u >= uOfLa[i+1]
    let i = Math.max(0, j - 1);
    while (i < NA - 2 && uOfLa[i + 1] > u) i++;
    const u0 = uOfLa[i], u1 = uOfLa[i + 1], f = u0 === u1 ? 0 : (u0 - u) / (u0 - u1);
    laOfLu[k] = LA0 + (LA1 - LA0) * (i + f) / (NA - 1);
  }
}
export function aOfU(u) {
  const x = (Math.log(Math.max(u, 1e-8)) - LU0) / (LU1 - LU0) * (NU - 1);
  if (x >= NU - 1) return 1e-4; if (x <= 0) return Math.exp(laOfLu[0]);
  const i = Math.floor(x), f = x - i; return Math.exp(laOfLu[i] * (1 - f) + laOfLu[i + 1] * f);
}
export const U_NOW = uOfA(1);    // comoving distance to the event horizon today (~5 Gpc)

// state for the current simulation time (years from J2000)
// The background temperature needs the radiation era too (a ~ t^1/2 before ~50,000 years): tabulate t(a) for
// radiation + matter + Lambda (Omega_r = 9.1e-5) and invert it.
const OR = 9.1e-5, NR = 600, LR0 = Math.log(1e-10), LR1 = Math.log(2);
const tOfLaR = new Float64Array(NR);
{
  let t = 0, a0 = Math.exp(LR0);
  t = a0 * a0 / (2 * Math.sqrt(OR)) / HGYR;          // pure radiation below the table
  tOfLaR[0] = t;
  for (let i = 1; i < NR; i++) {
    const la0 = LR0 + (LR1 - LR0) * (i - 1) / (NR - 1), la1 = LR0 + (LR1 - LR0) * i / (NR - 1);
    const f = (la) => { const a = Math.exp(la); return 1 / (HGYR * Math.sqrt(OR / (a * a * a * a) + OM / (a * a * a) + OL)); };   // dt/dln a
    t += (la1 - la0) * (f(la0) + 4 * f((la0 + la1) / 2) + f(la1)) / 6; tOfLaR[i] = t;
  }
}
// scale factor (a = 1 today) at cosmic time tau in Gyr, radiation included
export function aRad(tau) {
  if (tau >= tOfLaR[NR - 1]) return aOfTau(tau) / aOfTau(T0_GYR);
  if (tau <= tOfLaR[0]) return Math.exp(LR0) * Math.sqrt(Math.max(tau, 1e-30) / tOfLaR[0]);
  let lo = 0, hi = NR - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tOfLaR[m] < tau) lo = m; else hi = m; }
  const f = (Math.log(tau) - Math.log(tOfLaR[lo])) / (Math.log(tOfLaR[hi]) - Math.log(tOfLaR[lo]));
  return Math.exp(LR0 + (LR1 - LR0) * (lo + f) / (NR - 1));
}
export const cosmo = { a: 1, u: U_NOW, z0: 0, T: CMB0, tau: T0_GYR };
export function updateCosmo(tyr) {
  const tau = Math.max(T0_GYR + tyr / 1e9, 1e-12);
  const a = aOfTau(tau) / aOfTau(T0_GYR);
  cosmo.tau = tau; cosmo.a = a; cosmo.u = uOfA(a);
  // the cosmic background: after recombination (~380,000 years, 3000 K) it is the CMB cooling as 1/a; before, the
  // universe is an opaque glowing plasma at the same temperature
  cosmo.T = CMB0 / (tau < 30 ? aRad(tau) : a);
  return cosmo;
}
// for a galaxy at comoving distance chi (Mpc): position scale (angular diameter distance relative to today's view),
// surface brightness factor relative to today, and redshift now
export function galaxyView(chi) {
  if (chi < 3) return { s: 1, f: 1, z: 0 };
  const aE0 = aOfU(U_NOW + chi), aE = aOfU(cosmo.u + chi);
  const z0 = 1 / aE0 - 1, z = cosmo.a / aE - 1;
  return { s: aE / aE0, f: Math.pow((1 + z0) / (1 + z), 4), z };
}
// texture with ln a(ln u) for the galaxy shader
let tex = null;
export function cosmoTexture() {
  if (tex) return tex;
  tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, NU, 1, 0, gl.RED, gl.FLOAT, laOfLu);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
// cosmic age (Gyr) at scale factor a (a = 1 today; matter + Lambda)
export function tauOfA(a) { const x = Math.pow(Math.max(a, 1e-9) * aOfTau(T0_GYR) / K, 1.5); return 2 / (3 * Math.sqrt(OL)) * 977.792 / H0 * Math.asinh(x); }
// what an observer at the current time sees of a galaxy at comoving distance chi (Mpc): redshift, how long ago the light
// left it, its proper distance now and its recession speed now (Hubble's law, km/s; faster than light beyond ~4.4 Gpc today)
export function galaxyInfo(chi) {
  if (chi < 3) return null;
  const aE = aOfU(cosmo.u + chi), z = cosmo.a / aE - 1, D = chi * cosmo.a;
  return { z, lookback: cosmo.tau - tauOfA(aE), D, v: H0 * Hof(cosmo.a) * D, visible: aE > 0 };
}
export const COSMO_GLSL = `
uniform sampler2D uCosmo; uniform float uUnow, uUobs, uAobs, uTauObs;
// cosmic age (Gyr) at scale factor a (matter + Lambda; a = 1 today)
float cosmoTau(float a){ float x = pow(max(a, 1e-6)*${(aOfTau(T0_GYR) / Math.cbrt(OM / OL)).toFixed(6)}, 1.5); return ${(2 / (3 * Math.sqrt(OL)) * 977.792 / H0).toFixed(5)}*log(x + sqrt(x*x + 1.)); }
float cosmoLnA(float u){
  float x = (log(max(u, 1e-8)) - (${LU0.toFixed(6)}))/(${(LU1 - LU0).toFixed(6)})*${(NU - 1).toFixed(1)};
  x = clamp(x, 0., ${(NU - 1.001).toFixed(3)}); float i = floor(x);
  float a0 = texelFetch(uCosmo, ivec2(int(i), 0), 0).r, a1 = texelFetch(uCosmo, ivec2(int(i) + 1, 0), 0).r;
  return mix(a0, a1, x - i);
}
// returns (position scale, brightness factor, 1+z)
vec3 cosmoView(float chi){
  if (chi < 3.) return vec3(1., 1., 1.);
  float aE0 = exp(cosmoLnA(uUnow + chi)), aE = exp(cosmoLnA(uUobs + chi));
  float zp0 = 1./aE0, zp = uAobs/aE;
  return vec3(aE/aE0, pow(zp0/zp, 4.), zp/zp0);
}`;
// where a galaxy appears (Mpc, observer at the Milky Way)
export function apparentPosU(g) { const d = Math.hypot(g.posU[0], g.posU[1], g.posU[2]); const v = galaxyView(d); return v.s === 1 ? g.posU : g.posU.map(x => x * v.s); }
