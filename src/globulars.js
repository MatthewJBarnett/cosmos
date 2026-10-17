// Globular clusters: the Milky Way's oldest star systems (11-13 Gyr), hundreds of thousands of stars within a few
// tens of parsecs, orbiting in the halo. Twelve famous ones at their measured positions (Harris 1996, 2010 edition:
// galactic longitude and latitude, distance, absolute magnitude, half-light radius) plus a procedural population
// (~140 in all, density falling as r^-3.5 from the centre). Each follows an orbit around the Galaxy (a tilted
// circle at ~200 km/s), so their places in the sky change over hundreds of millions of years.
import { V, Q } from './math.js';
import { SUN_POS, galDir } from './universe.js';
import { KMS_PCYR, OMEGA_P, rotY } from './galdyn.js';

// [name, l, b, distance (kpc), M_V, half-light radius (pc)]
const REAL = [
  ['Omega Centauri', 309.10, 14.97, 5.2, -10.26, 7.6], ['47 Tucanae', 305.89, -44.89, 4.5, -9.42, 4.2],
  ['M13 (Hercules Cluster)', 59.01, 40.91, 7.1, -8.55, 3.4], ['M22', 9.89, -7.55, 3.2, -8.50, 3.1],
  ['M4', 350.97, 15.97, 2.2, -7.19, 2.9], ['M5', 3.86, 46.80, 7.5, -8.81, 3.9], ['M15', 65.01, -27.31, 10.4, -9.19, 3.0],
  ['M3', 42.22, 78.71, 10.2, -8.88, 6.7], ['NGC 6397', 338.17, -11.96, 2.3, -6.64, 1.9], ['M92', 68.34, 34.86, 8.3, -8.21, 2.4],
  ['M2', 53.37, -35.78, 11.5, -9.03, 3.9], ['NGC 6752', 336.49, -25.63, 4.0, -7.73, 2.2],
];
const V_HALO = 200 * KMS_PCYR;     // rad/yr * pc: orbital speed
export const GLOBULARS = [];
{
  let s = 4242; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const unit = () => { let v; do { v = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]; } while (V.len(v) > 1 || V.len(v) < 0.1); return V.norm(v); };
  for (const [name, l, b, d, MV, rh] of REAL) GLOBULARS.push({ name, pos0: V.addm(SUN_POS, galDir(l, b), d * 1000), MV, rh, real: true });
  for (let i = 0; i < 130; i++) {
    // radius from a r^-3.5 profile with a 1 kpc core, inside ~40 kpc
    let r; do { r = 1000 * Math.pow(rnd(), -1 / 2.5); } while (r > 40000);
    r = Math.max(r * 0.8, 600);
    const MV = -5.2 - 4 * Math.pow(rnd(), 1.8), rh = 1.5 + 5 * rnd() * rnd();
    GLOBULARS.push({ name: 'NGC ' + (5000 + Math.floor(rnd() * 2400)), pos0: V.mul(unit(), r), MV, rh });
  }
  // each on a tilted circular orbit through its present position
  for (const g of GLOBULARS) {
    const rhat = V.norm(g.pos0); let n = V.norm(V.cross(rhat, unit())); if (!isFinite(n[0])) n = [0, 1, 0];
    g.axis = n; g.R = V.len(g.pos0); g.lum = Math.pow(10, -0.4 * (g.MV - 4.83));
  }
}
// galaxy-local (pattern frame) position at t years from now
export function globularPos(g, tyr) {
  const ang = V_HALO / Math.max(g.R, 500) * tyr;
  const p = Q.rot(Q.axis(g.axis, ang), g.pos0);
  return rotY(p, OMEGA_P * tyr);
}
// unresolved clusters as point sources (fading out once the cluster is resolved and drawn as a ball of stars)
export function globularPoints(camLocal, gq, tyr, pxPerRad, out) {
  if (tyr < -12.9e9) return out;          // (they formed with the Galaxy's halo, ~13 Gyr ago)
  for (const g of GLOBULARS) {
    const p = globularPos(g, tyr), rel = V.sub(p, camLocal), d = V.len(rel);
    if (d < 1e-3) continue;
    const m = g.MV + 5 * Math.log10(d) - 5; if (m > 14) continue;
    const px = g.rh * 3 / d * pxPerRad, k = Math.max(0, Math.min(1, (4 - px) / 3));
    if (k <= 0) continue;
    out.push({ dir: Q.rot(gq, rel), color: [1.0, 0.88, 0.7], flux: Math.exp(-0.9210340372 * (m + 26.74)) * k, m, name: g.name });
  }
  return out;
}
// resolved clusters for the volumetric renderer (type 4)
export function globularNebulae(tyr) {
  if (tyr < -12.9e9) return [];
  return GLOBULARS.map(g => {
    if (!g.neb) g.neb = { radius: g.rh * 6, type: 4, seed: (g.R % 97) / 9.7, colA: [1.0, 0.86, 0.66], colB: [0.75, 0.82, 1.0], name: g.name, far: true, cluster: true };
    g.neb.pos = globularPos(g, tyr);
    // surface brightness: total light spread over the core
    g.neb.lum = 2.5 * g.lum / 1e5 / Math.pow(g.rh / 4, 2);
    return g.neb;
  });
}
