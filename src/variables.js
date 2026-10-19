// Variable stars in the catalogue: brightness changes from eclipses and pulsations, evaluated on the CPU and
// averaged over the frame (at high time rates a fast variable shows its mean light, as a long exposure would).
import { catalog } from './assets.js';

const JD2000 = 2451545.0;
// [name, kind, period (days), epoch (JD of minimum or maximum), parameters]
const VARS = [
  // Algol: detached eclipsing binary, primary eclipse 2.1 -> 3.4 mag lasting ~10 hours (GCVS ephemeris)
  { name: 'Algol', P: 2.8673043, E: 2445641.5135, f: (ph) => { const x = Math.min(ph, 1 - ph) * 2.8673043 * 24; return 1.3 * Math.max(0, 1 - (x / 4.9) ** 2) ** 0.7 + (Math.abs(ph - 0.5) * 2.8673043 * 24 < 4.9 ? 0.06 : 0); } },
  // Mira: long period variable, ~2 to ~10 mag over 332 days (brightness relative to the catalogue value)
  { name: 'Mira', P: 331.96, E: 2444839, f: (ph) => 3.2 * (1 - Math.cos(2 * Math.PI * ph)) / 2 - 1.6 + 0.6 * Math.sin(2 * Math.PI * ph) * 0.3 },
  // Beta Lyrae (Sheliak): contact-like eclipsing binary, 12.94 days, unequal minima
  { name: 'Sheliak', P: 12.9414, E: 2455434.9, f: (ph) => 0.55 * (1 + Math.cos(4 * Math.PI * ph)) / 2 + 0.28 * (1 + Math.cos(2 * Math.PI * ph)) / 2 - 0.35 },
  // Epsilon Aurigae: a star eclipsed for nearly two years every 27.1 years by a dark disk (last mid-eclipse Aug 2010)
  { name: 'Almaaz', P: 9896, E: 2455400, f: (ph) => { const d = Math.min(ph, 1 - ph) * 9896; return 0.75 * Math.min(1, Math.max(0, (330 - d) / 90)); } },
  // Zeta Geminorum (Mekbuda): classical Cepheid, 10.15 days, sawtooth light curve
  { name: 'Mekbuda', P: 10.15073, E: 2443805.927, f: (ph) => { const s = ph < 0.25 ? 1 - ph / 0.25 : (ph - 0.25) / 0.75; return 0.56 * s - 0.28; } },
  // Betelgeuse: semi-regular, ~400 day pulsation on a ~2100 day long secondary period (0.0 - 1.6 mag)
  { name: 'Betelgeuse', P: 400, E: 2451545, f: (ph, jd) => 0.25 * Math.sin(2 * Math.PI * ph) + 0.18 * Math.sin(2 * Math.PI * (jd - 2451545) / 2100) },
  // Eta Carinae (not a named catalogue entry: found by direction): the Great Eruption of 1837-1858 made it the second
  // brightest star in the sky (-0.8 in March 1843); dust from the ejected Homunculus nebula then hid it (~8 by 1900);
  // it has been brightening again since the 1940s (~4.3 now). Recorded magnitudes, interpolated; quiet at ~3 before.
  { name: 'Eta Carinae', find: [287.597, -0.630], P: 1e9, E: 0, f: (ph, jd) => etaCar(2000 + (jd - 2451545) / 365.25) },
  // classical Cepheids (GCVS periods and epochs of maximum): a fast rise and a slow decline; the period-luminosity law
  // they follow is how distances to galaxies were first measured (Leavitt 1912, Hubble 1924)
  { name: 'Delta Cephei', find: [105.194, 0.531, 150, 600, 4.0], P: 5.366249, E: 2436075.445, f: cepheid(0.86) },
  { name: 'Eta Aquilae', find: [40.934, -13.073, 120, 600, 3.9], P: 7.176641, E: 2436084.656, f: cepheid(0.83) },
  { name: 'Beta Doradus', find: [271.734, -32.774, 150, 700, 3.8], P: 9.8426, E: 2440905.3, f: cepheid(0.62) },
  { name: 'l Carinae', find: [283.199, -7.004, 250, 1000, 3.7], P: 35.557, E: 2440736.24, f: cepheid(0.9) },
  // Polaris: a Cepheid whose pulsation almost died out in the 1990s (0.03 mag) and is growing again
  { name: 'Polaris', P: 3.9696, E: 2428260.727, f: (ph, jd) => Math.min(0.05, 0.012 + 0.0025 * Math.abs((jd - 2449000) / 3652.5)) * Math.cos(2 * Math.PI * ph) },
  // RR Lyrae: the prototype of the old, metal-poor pulsators that trace the galactic halo (0.567 days, ~1 mag)
  { name: 'RR Lyrae', find: [74.952, 12.304, 150, 600, 7.6], P: 0.5668378, E: 2442923.4193, f: cepheid(1.06, 0.15) },
];
// light curve of a radial pulsator: rise over the first fraction of the cycle, slower decline (amplitude in mag, peak at 0)
function cepheid(amp, rise = 0.3) { return (ph) => { const s = ph < rise ? 1 - ph / rise : (ph - rise) / (1 - rise); return amp * (s - 0.5); }; }
const ETA_CAR = [[1600, 3.2], [1827, 1.5], [1834, 2.0], [1837.9, 0.2], [1838.5, 1.0], [1843.2, -0.8], [1845, 0.5], [1850, 0.0], [1856, 0.6],
  [1858, 1.5], [1862, 3.5], [1868, 6.0], [1880, 7.6], [1900, 7.9], [1940, 7.0], [1953, 6.2], [1975, 6.1], [1998, 5.0], [2010, 4.7], [2026, 4.2]];
function etaCar(y) {
  let m = y <= ETA_CAR[0][0] ? ETA_CAR[0][1] : ETA_CAR[ETA_CAR.length - 1][1];
  for (let k = 1; k < ETA_CAR.length; k++) if (y < ETA_CAR[k][0]) { const [y0, m0] = ETA_CAR[k - 1], [y1, m1] = ETA_CAR[k]; m = y < y0 ? m0 : m0 + (m1 - m0) * (y - y0) / (y1 - y0); break; }
  return m - etaCarCat;
}
let etaCarCat = 4.2;
let resolved = false;
// the brightest catalogue star within a small cone (cos limit) of a galactic direction, in a distance range, near an
// expected apparent magnitude; -1 if none
function findStar(lD, bD, rmin, rmax, mExp, cosLim = 0.99996) {
  const l = lD * Math.PI / 180, b = bD * Math.PI / 180, u = [Math.cos(b) * Math.cos(l), Math.sin(b), -Math.cos(b) * Math.sin(l)], d = catalog.data;
  let best = -1, bm = 99;
  for (let i = 0; i < catalog.count; i++) { const x = d[i * 5], y = d[i * 5 + 1], z = d[i * 5 + 2], r = Math.hypot(x, y, z); if (r < rmin || r > rmax) continue;
    if ((x * u[0] + y * u[1] + z * u[2]) / r < cosLim) continue; const m = d[i * 5 + 3] + 5 * Math.log10(r / 10); if (m < bm) { bm = m; best = i; } }
  return best >= 0 && (mExp > 50 || Math.abs(bm - mExp) < 1.2) ? best : -1;
}
function resolve() {
  if (resolved || !catalog.ready) return;
  for (const v of VARS) {
    if (v.find) {
      // the brightest catalogue star within half a degree of the given galactic direction, beyond 1 kpc
      const l = v.find[0] * Math.PI / 180, b = v.find[1] * Math.PI / 180, u = [Math.cos(b) * Math.cos(l), Math.sin(b), -Math.cos(b) * Math.sin(l)], d = catalog.data;
      let best = -1, bm = 99;
      const [rmin, rmax, mExp] = v.find.length > 2 ? v.find.slice(2) : [1000, 1e9, 99];
      for (let i = 0; i < catalog.count; i++) { const x = d[i * 5], y = d[i * 5 + 1], z = d[i * 5 + 2], r = Math.hypot(x, y, z); if (r < rmin || r > rmax) continue;
        if ((x * u[0] + y * u[1] + z * u[2]) / r < 0.99996) continue; const m = d[i * 5 + 3] + 5 * Math.log10(r / 10); if (m < bm) { bm = m; best = i; } }
      v.i = best >= 0 && (mExp > 50 || Math.abs(bm - mExp) < 1.2) ? best : -1; if (best >= 0 && v.name === 'Eta Carinae') etaCarCat = bm;
      continue;
    }
    const n = catalog.named.find(x => x.name === v.name); v.i = n ? n.i : -1;
  }
  resolved = true;
}
// returns { idx: Int32Array(16), dm: Float32Array(16) } for time t (s since J2000) and frame window win (days)
const out = { idx: new Int32Array(16).fill(-1), dm: new Float32Array(16) };
export function variableStars(t, winDays) {
  resolve();
  const jd = JD2000 + t / 86400;
  VARS.forEach((v, k) => {
    out.idx[k] = v.i === undefined ? -1 : v.i;
    // average flux over the frame window (8 samples), then back to magnitudes
    const n = winDays > v.P * 0.01 ? 8 : 1; let fl = 0;
    for (let s = 0; s < n; s++) {
      const j = jd - winDays * s / Math.max(n - 1, 1) * (n > 1 ? 1 : 0);
      let ph = ((j - v.E) / v.P) % 1; if (ph < 0) ph += 1;
      fl += Math.pow(10, -0.4 * v.f(ph, j));
    }
    out.dm[k] = -2.5 * Math.log10(fl / n);
  });
  return out;
}

// young stars with measured ages (Myr): before their birth they are not in the sky; each switches on over ~100,000 years
// (the Orion Nebula's brightest stars are younger than a million years: run the clock forward from 2 Myr ago and
// they switch on; older ones, like Orion's belt, are older than the ~3 Myr that the star catalogue reaches)
const YOUNG = [['Theta2 Ori A (Orion Nebula cluster)', 0.6, [209.0485, -19.3722, 200, 700, 5.0]],
  ['Sigma Ori', 3, [206.8163, -17.336, 200, 700, 3.8]], ['Naos', 3.2], ['Meissa', 5], ['Alnilam', 5.7], ['Alnitak', 6.4], ['Mintaka', 7], ['Rigel', 8], ['Betelgeuse', 8.5],
  ['Deneb', 10], ['Mimosa', 10], ['Acrux', 10], ['Wezen', 10], ['Antares', 11], ['Saiph', 11.6], ['Spica', 12.5], ['Hadar', 14],
  ['Adhara', 22], ['Bellatrix', 25], ['Canopus', 25]];
const young = { idx: new Int32Array(24).fill(-1), w: new Float32Array(24).fill(1) };
let youngResolved = false;
export function youngStars(tyr) {
  if (!youngResolved && catalog.ready) { YOUNG.forEach(([n, , f], k) => { if (f) { young.idx[k] = findStar(f[0], f[1], f[2], f[3], f[4], 0.99999995); return; } const x = catalog.named.find(q => q.name === n); young.idx[k] = x ? x.i : -1; }); youngResolved = true; }
  YOUNG.forEach(([, age], k) => { young.w[k] = Math.min(1, Math.max(0, (tyr + age * 1e6) / 1e5)); });
  return young;
}
