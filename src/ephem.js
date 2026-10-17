// Ephemerides: JPL approximate planetary elements with secular rates (Standish, valid 1800-2050)
// and the Moon from Meeus' truncated ELP2000 series (accuracy ~10 arcseconds), so phases and eclipses are real.
const D2R = Math.PI / 180;

// [a, e, I, L, long.peri, long.node] at J2000 and rates per Julian century
export const JPL = {
  Mercury: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593], [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
  Venus: [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255], [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
  Earth: [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0], [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
  Mars: [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891], [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
  Jupiter: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
  Saturn: [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448], [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
  Uranus: [[19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503], [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]],
  Neptune: [[30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574], [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]],
  Pluto: [[39.48211675, 0.24882730, 17.14001206, 238.92903833, 224.06891629, 110.30393684], [-0.00031596, 0.00005170, 0.00004818, 145.20780515, -0.04062942, -0.01183482]],
};
const AU = 1.495978707e11;

// ---- secular (orbit-averaged) evolution over millions of years: Laplace-Lagrange theory ----
// The planets slowly twist each other's orbits: perihelia and nodes precess and eccentricities and inclinations
// trade back and forth in a sum of normal modes (Murray & Dermott ch. 7). The modes are computed here from the
// masses and semi-major axes alone, plus general relativity's perihelion advance (Mercury's 43"/century).
// Earth's eccentricity swings between ~0 and ~0.06 with the ~100,000 and 405,000 year periods behind the ice ages.
const SEC_NAMES = ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
const SEC_MASS = [1.6601e-7, 2.4478e-6, 3.0404e-6, 3.2272e-7, 9.5479e-4, 2.8589e-4, 4.3662e-5, 5.1514e-5];   // M_sun (Earth + Moon)
let SEC = null;
function laplaceB(j, al) { const N = 256; let s = 0; for (let i = 0; i < N; i++) { const p = 2 * Math.PI * i / N; s += Math.cos(j * p) / Math.pow(1 - 2 * al * Math.cos(p) + al * al, 1.5); } return 2 * s / N; }
// eigen-decomposition of a symmetric matrix (cyclic Jacobi)
function jacobi(S) {
  const n = S.length, A = S.map(r => r.slice()), U = A.map((r, i) => r.map((_, j) => +(i === j)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const ukp = U[k][p], ukq = U[k][q]; U[k][p] = c * ukp - s * ukq; U[k][q] = s * ukp + c * ukq; }
    }
  }
  return { val: A.map((r, i) => r[i]), U };
}
function secularInit() {
  const n = 8, el = SEC_NAMES.map(k => JPL[k][0]), a = el.map(x => x[0]), m = SEC_MASS;
  const nn = a.map(x => 2 * Math.PI / Math.pow(x, 1.5));       // mean motions, rad/yr
  const A = a.map(() => new Array(n).fill(0)), B = a.map(() => new Array(n).fill(0));
  for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    if (j === k) continue;
    const al = Math.min(a[j], a[k]) / Math.max(a[j], a[k]), alb = a[j] < a[k] ? al : 1;
    const f = nn[j] / 4 * m[k] / (1 + m[j]) * al * alb, b1 = laplaceB(1, al), b2 = laplaceB(2, al);
    A[j][j] += f * b1; A[j][k] = -f * b2; B[j][j] -= f * b1; B[j][k] = f * b1;
  }
  // general relativity: 3 GM n / (c^2 a (1 - e^2))
  for (let j = 0; j < n; j++) A[j][j] += 3 * 9.8706e-9 / (a[j] * (1 - el[j][1] ** 2)) * nn[j];
  // symmetrize with the angular momentum weights sqrt(m sqrt(a)), then solve the two eigenproblems
  const d = a.map((x, j) => Math.sqrt(m[j] * Math.sqrt(x)));
  const sym = (M) => M.map((r, j) => r.map((v, k) => d[j] * v / d[k])).map((r, j, R) => r.map((v, k) => 0.5 * (v + R[k][j])));
  const modes = (M, x0, y0) => {
    const { val, U } = jacobi(sym(M));
    // initial amplitudes: X = U^T D x0
    const X = val.map((_, i) => U.reduce((s, row, j) => s + row[i] * d[j] * x0[j], 0)), Y = val.map((_, i) => U.reduce((s, row, j) => s + row[i] * d[j] * y0[j], 0));
    const V = U.map((row, j) => row.map(u => u / d[j]));    // eigenvectors of M
    return { g: val, V, X, Y };
  };
  const D = (x) => x * D2R;
  SEC = {
    e: modes(A, el.map(x => x[1] * Math.sin(D(x[4]))), el.map(x => x[1] * Math.cos(D(x[4])))),
    i: modes(B, el.map(x => Math.sin(D(x[2])) * Math.sin(D(x[5]))), el.map(x => Math.sin(D(x[2])) * Math.cos(D(x[5])))),
  };
}
let secT = NaN, secR = null;
// h = e sin(perihelion longitude), k = e cos(..), p = sin I sin(node), q = sin I cos(node), at t years from J2000
export function secularAt(t) {
  if (t === secT) return secR;
  if (!SEC) secularInit();
  const out = { h: new Array(8).fill(0), k: new Array(8).fill(0), p: new Array(8).fill(0), q: new Array(8).fill(0) };
  for (const [key, x, y] of [['e', 'h', 'k'], ['i', 'p', 'q']]) {
    const M = SEC[key];
    for (let i = 0; i < 8; i++) {
      const c = Math.cos(M.g[i] * t), s = Math.sin(M.g[i] * t), sx = M.X[i] * c + M.Y[i] * s, sy = M.Y[i] * c - M.X[i] * s;
      for (let j = 0; j < 8; j++) { out[x][j] += M.V[j][i] * sx; out[y][j] += M.V[j][i] * sy; }
    }
  }
  secT = t; secR = out; return out;
}
export const secularModes = () => { if (!SEC) secularInit(); return SEC; };
// Earth's eccentricity and longitude of perihelion (deg, J2000 ecliptic) at t years
let joinP = null, joinM = null;
export function earthOrbitAt(t) {
  const T = t / 100, Ts = Math.max(-50, Math.min(50, T)), e0 = JPL.Earth[0], r = JPL.Earth[1];
  let e = e0[1] + r[1] * Ts, w = (e0[4] + r[4] * Ts) * D2R, h = e * Math.sin(w), k = e * Math.cos(w);
  if (T !== Ts) {
    // (Earth only: called ~100,000 times when the ice-age history is built)
    const M = secularModes().e, hk = (tt) => { let a = 0, b = 0; for (let i = 0; i < 8; i++) { const c = Math.cos(M.g[i] * tt), s = Math.sin(M.g[i] * tt), v = M.V[2][i]; a += v * (M.X[i] * c + M.Y[i] * s); b += v * (M.Y[i] * c - M.X[i] * s); } return [a, b]; };
    const s1 = hk(t), s0 = Ts > 0 ? (joinP || (joinP = hk(5000))) : (joinM || (joinM = hk(-5000))); h += s1[0] - s0[0]; k += s1[1] - s0[1];
  }
  return { e: Math.hypot(h, k), varpi: Math.atan2(h, k) / D2R };
}
// t: seconds since J2000 (UTC); returns heliocentric position (m) in the J2000 ecliptic frame, engine axes (y = north)
export function planetPos(name, t) {
  const el = JPL[name]; if (!el) return null;
  const T = (t + 69.2) / (36525 * 86400);
  const [e0, r] = el;
  // the secular rates are fits to a few centuries: they are used out to +-50 centuries
  const Ts = Math.max(-50, Math.min(50, T));
  const a = (e0[0] + r[0] * Ts) * AU;
  let e = e0[1] + r[1] * Ts, I = (e0[2] + r[2] * Ts) * D2R, w = e0[4] + r[4] * Ts, O = (e0[5] + r[5] * Ts) * D2R;
  // further out, the Laplace-Lagrange secular solution carries the orbits' slow changes (continuous at the join)
  const si = SEC_NAMES.indexOf(name);
  if (T !== Ts && si >= 0) {
    const s1 = secularAt(T * 100), s0 = secularAt(Ts * 100);
    const h = e * Math.sin(w * D2R) + s1.h[si] - s0.h[si], k = e * Math.cos(w * D2R) + s1.k[si] - s0.k[si];
    const p = Math.sin(I) * Math.sin(O) + s1.p[si] - s0.p[si], q = Math.sin(I) * Math.cos(O) + s1.q[si] - s0.q[si];
    const wn = Math.atan2(h, k) / D2R;
    e = Math.min(Math.hypot(h, k), 0.9); I = Math.asin(Math.min(Math.hypot(p, q), 1)); O = Math.atan2(p, q);
    // the mean longitude carries on at the mean motion; the mean anomaly is measured from the moving perihelion
    return keplerPos(a, e, I, O, wn, e0[3] + r[3] * T);
  }
  return keplerPos(a, e, I, O, w, e0[3] + r[3] * T + (r[4] * (T - Ts)));
}
function keplerPos(a, e, I, O, w, L) {
  const argp = w * D2R - O;
  let M = (((L - w) % 360) + 360) % 360 * D2R;
  let E = M; for (let i = 0; i < 12; i++) { const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); E -= dE; if (Math.abs(dE) < 1e-13) break; }
  const xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(argp), sw = Math.sin(argp), cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(I), si = Math.sin(I);
  const x = (cO * cw - sO * sw * ci) * xv + (-cO * sw - sO * cw * ci) * yv;
  const y = (sO * cw + cO * sw * ci) * xv + (-sO * sw + cO * cw * ci) * yv;
  const z = (sw * si) * xv + (cw * si) * yv;
  return [x, z, -y];
}

// Meeus, Astronomical Algorithms ch. 47 (largest terms). [D, M, M', F, sum_l (1e-6 deg), sum_r (1e-3 km)]
const LR = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968], [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149], [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733], [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0], [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210], [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824], [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403], [0, 1, -2, 0, -2689, -7003],
  [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056], [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884],
  [0, 1, 2, 0, -2120, 5751], [0, 2, 0, 0, -2069, 0], [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958], [0, 0, 2, 2, -1110, 0], [3, 0, -1, 0, -892, 3258],
  [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897], [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354],
  [2, 1, -2, 0, 691, 0], [2, -1, 0, -2, 596, 0], [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
];
const B = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237], [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198], [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211], [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870],
  [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794], [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335], [0, 0, 3, 1, 1107], [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833],
];
// geocentric Moon position (m), J2000 ecliptic frame, engine axes
export function moonPos(t) {
  const T = (t + 69.2) / (36525 * 86400);
  // quadratic terms and the eccentricity factor E are only valid for a few thousand years
  const Tq = Math.max(-50, Math.min(50, T)), T2 = Tq * T;
  const Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T2;
  const D = (297.8501921 + 445267.1114034 * T - 0.0018819 * T2) * D2R;
  const M = (357.5291092 + 35999.0502909 * T - 0.0001536 * T2) * D2R;
  const Mp = (134.9633964 + 477198.8675055 * T + 0.0087414 * T2) * D2R;
  const F = (93.2720950 + 483202.0175233 * T - 0.0036539 * T2) * D2R;
  const A1 = (119.75 + 131.849 * T) * D2R, A2 = (53.09 + 479264.290 * T) * D2R, A3 = (313.45 + 481266.484 * T) * D2R;
  const E = 1 - 0.002516 * Tq - 0.0000074 * Tq * Tq;
  let sl = 0, sr = 0, sb = 0;
  for (const [d, m, mp, f, l, r] of LR) {
    const arg = d * D + m * M + mp * Mp + f * F, k = m === 0 ? 1 : (Math.abs(m) === 1 ? E : E * E);
    sl += l * k * Math.sin(arg); sr += r * k * Math.cos(arg);
  }
  for (const [d, m, mp, f, b] of B) { const k = m === 0 ? 1 : (Math.abs(m) === 1 ? E : E * E); sb += b * k * Math.sin(d * D + m * M + mp * Mp + f * F); }
  const LpR = Lp * D2R;
  sl += 3958 * Math.sin(A1) + 1962 * Math.sin(LpR - F) + 318 * Math.sin(A2);
  sb += -2235 * Math.sin(LpR) + 382 * Math.sin(A3) + 175 * Math.sin(A1 - F) + 175 * Math.sin(A1 + F) + 127 * Math.sin(LpR - Mp) - 115 * Math.sin(LpR + Mp);
  // ecliptic of date -> J2000 ecliptic (general precession in longitude)
  const lam = (Lp + sl / 1e6 - 1.396971 * T) * D2R, bet = sb / 1e6 * D2R, dist = (385000.56 + sr / 1000) * 1000;
  const x = dist * Math.cos(bet) * Math.cos(lam), y = dist * Math.cos(bet) * Math.sin(lam), z = dist * Math.sin(bet);
  return [x, z, -y];
}

// IAU north pole directions (J2000 equatorial RA, Dec in degrees)
export const POLES = { Sun: [286.13, 63.87], Mercury: [281.0103, 61.4155], Venus: [272.76, 67.16], Earth: [0, 90], Mars: [317.269, 54.432], Jupiter: [268.057, 64.495],
  Saturn: [40.589, 83.537], Uranus: [257.311, -15.175], Neptune: [299.36, 43.46], Pluto: [132.993, -6.163], Moon: [269.9949, 66.5392], Io: [268.05, 64.5], Europa: [268.08, 64.51], Ganymede: [268.2, 64.57], Callisto: [268.72, 64.83], Titan: [39.4827, 83.4279] };
// equatorial (RA, Dec) -> unit vector in J2000 ecliptic frame, engine axes
export function eqToEngine(ra, dec) {
  const e = 23.4392911 * D2R, a = ra * D2R, d = dec * D2R;
  const x = Math.cos(d) * Math.cos(a), y = Math.cos(d) * Math.sin(a), z = Math.sin(d);
  const ye = y * Math.cos(e) + z * Math.sin(e), ze = -y * Math.sin(e) + z * Math.cos(e);
  return [x, ze, -ye];
}
// Galilean satellites (Meeus ch. 44, low accuracy). Returns for each moon [u (rad, from superior conjunction as seen from Earth), r (Jupiter radii)].
export function galilean(t) {
  const d = (t + 69.2) / 86400;
  const V = (172.74 + 0.00111588 * d) * D2R, M = (357.529 + 0.9856003 * d) * D2R;
  const N = (20.020 + 0.0830853 * d + 0.329 * Math.sin(V)) * D2R, J = 66.115 + 0.9025179 * d - 0.329 * Math.sin(V);
  const A = 1.915 * Math.sin(M) + 0.020 * Math.sin(2 * M), B = 5.555 * Math.sin(N) + 0.168 * Math.sin(2 * N);
  const K = (J + A - B) * D2R;
  const R = 1.00014 - 0.01671 * Math.cos(M) - 0.00014 * Math.cos(2 * M), r = 5.20872 - 0.25208 * Math.cos(N) - 0.00611 * Math.cos(2 * N);
  const Dl = Math.sqrt(r * r + R * R - 2 * r * R * Math.cos(K));
  const psi = Math.asin(R / Dl * Math.sin(K)) / D2R;
  const dd = d - Dl / 173;
  let u1 = 163.8069 + 203.4058646 * dd + psi - B, u2 = 358.4140 + 101.2916335 * dd + psi - B, u3 = 5.7176 + 50.2345180 * dd + psi - B, u4 = 224.8092 + 21.4879800 * dd + psi - B;
  const G = (331.18 + 50.310482 * dd) * D2R, H = (87.45 + 21.569231 * dd) * D2R;
  const c1 = 0.473 * Math.sin(2 * (u1 - u2) * D2R), c2 = 1.065 * Math.sin(2 * (u2 - u3) * D2R), c3 = 0.165 * Math.sin(G), c4 = 0.843 * Math.sin(H);
  const r1 = 5.9057 - 0.0244 * Math.cos(2 * (u1 - u2) * D2R), r2 = 9.3966 - 0.0882 * Math.cos(2 * (u2 - u3) * D2R), r3 = 14.9883 - 0.0216 * Math.cos(G), r4 = 26.3627 - 0.1939 * Math.cos(H);
  return [[(u1 + c1) * D2R, r1], [(u2 + c2) * D2R, r2], [(u3 + c3) * D2R, r3], [(u4 + c4) * D2R, r4]];
}

// IAU prime meridian angle W = W0 + Wd * days (degrees)
export const PRIME = { Sun: [84.176, 14.1844000], Mercury: [329.5469, 6.1385025], Venus: [160.20, -1.4813688], Mars: [176.630, 350.89198226], Jupiter: [284.95, 870.5360000],
  Saturn: [38.90, 810.7939024], Uranus: [203.81, -501.1600928], Neptune: [249.978, 541.1397757], Pluto: [302.695, 56.3625225],
  Moon: [38.3213, 13.17635815] };
// node of a body's equator on the Earth's equator, as an engine-frame unit vector
export function iauNode(ra, dec) {
  const a = ra * D2R;
  // Q = z_eq x pole = direction (RA = ra + 90 deg, Dec = 0)
  return eqToEngine(ra + 90, 0);
}
// the same on a uniform time grid (fast: the normal modes are advanced by rotation, not re-evaluated)
export function earthOrbitGrid(t0, dt, n) {
  const M = secularModes().e, v = M.V[2], E = new Float64Array(n), W = new Float64Array(n);
  const c = M.g.map(g => Math.cos(g * t0)), sn = M.g.map(g => Math.sin(g * t0)), cd = M.g.map(g => Math.cos(g * dt)), sd = M.g.map(g => Math.sin(g * dt));
  const ref = (tt) => earthOrbitAt(tt), jp = ref(5000), jm = ref(-5000), hk = (tt) => { let a = 0, b = 0; for (let i = 0; i < 8; i++) { const cc = Math.cos(M.g[i] * tt), ss = Math.sin(M.g[i] * tt); a += v[i] * (M.X[i] * cc + M.Y[i] * ss); b += v[i] * (M.Y[i] * cc - M.X[i] * ss); } return [a, b]; };
  const sp = hk(5000), sm = hk(-5000);
  for (let j = 0; j < n; j++) {
    const t = t0 + j * dt;
    if (Math.abs(t) <= 5000) { const o = earthOrbitAt(t); E[j] = o.e; W[j] = o.varpi; }
    else {
      let a = 0, b = 0; for (let i = 0; i < 8; i++) { a += v[i] * (M.X[i] * c[i] + M.Y[i] * sn[i]); b += v[i] * (M.Y[i] * c[i] - M.X[i] * sn[i]); }
      const J = t > 0 ? jp : jm, s0 = t > 0 ? sp : sm, w = J.varpi * D2R;
      const h = J.e * Math.sin(w) + a - s0[0], k = J.e * Math.cos(w) + b - s0[1];
      E[j] = Math.hypot(h, k); W[j] = Math.atan2(h, k) / D2R;
    }
    for (let i = 0; i < 8; i++) { const x = c[i] * cd[i] - sn[i] * sd[i]; sn[i] = sn[i] * cd[i] + c[i] * sd[i]; c[i] = x; }
  }
  return { E, W };
}
