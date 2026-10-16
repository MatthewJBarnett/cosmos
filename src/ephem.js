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
// t: seconds since J2000 (UTC); returns heliocentric position (m) in the J2000 ecliptic frame, engine axes (y = north)
export function planetPos(name, t) {
  const el = JPL[name]; if (!el) return null;
  const T = (t + 69.2) / (36525 * 86400);
  const [e0, r] = el;
  const a = (e0[0] + r[0] * T) * AU, e = e0[1] + r[1] * T, I = (e0[2] + r[2] * T) * D2R, L = e0[3] + r[3] * T, w = e0[4] + r[4] * T, O = (e0[5] + r[5] * T) * D2R;
  const argp = w * D2R - O;
  let M = ((L - w) % 360) * D2R;
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
  const Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T * T;
  const D = (297.8501921 + 445267.1114034 * T - 0.0018819 * T * T) * D2R;
  const M = (357.5291092 + 35999.0502909 * T - 0.0001536 * T * T) * D2R;
  const Mp = (134.9633964 + 477198.8675055 * T + 0.0087414 * T * T) * D2R;
  const F = (93.2720950 + 483202.0175233 * T - 0.0036539 * T * T) * D2R;
  const A1 = (119.75 + 131.849 * T) * D2R, A2 = (53.09 + 479264.290 * T) * D2R, A3 = (313.45 + 481266.484 * T) * D2R;
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;
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
  Saturn: [38.90, 810.7939024], Uranus: [203.81, -501.1600928], Neptune: [249.978, 541.1397757], Pluto: [302.695, 56.3625225] };
// node of a body's equator on the Earth's equator, as an engine-frame unit vector
export function iauNode(ra, dec) {
  const a = ra * D2R;
  // Q = z_eq x pole = direction (RA = ra + 90 deg, Dec = 0)
  return eqToEngine(ra + 90, 0);
}
