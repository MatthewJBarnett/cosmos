// Core collapse supernovae: light curves, light travel delay, frame-averaged brightness at high time rates,
// and expanding remnants. Procedural massive stars explode at the end of their life cycles (galdyn.SN_CLASSES);
// a few real stars have scheduled explosions.
import { V, Q, C } from './math.js';
import { world, SN_CLASSES, SN_LIVE, YEAR, KMS_PCYR } from './galdyn.js';
import { catalog } from './assets.js';
import { bbColor } from './stars.js';

const LY_PER_PC = 3.2616;
const DAY = 1 / 365.25;

// absolute V magnitude after explosion (t in days). Type II-P: rise, ~100 day hydrogen recombination plateau,
// drop, then the radioactive tail of cobalt-56 (0.98 mag per 100 days). Stripped (Ib/c) supernovae from the most
// massive stars: faster rise and decline.
function magIIP(d) {
  if (d < 0) return 99;
  if (d < 12) return -13.5 - 3.6 * Math.sqrt(d / 12);
  if (d < 100) return -17.1 + 0.6 * (d - 12) / 88;
  if (d < 125) return -16.5 + 2.2 * (d - 100) / 25;
  return -14.3 + 0.0098 * (d - 125);
}
function magIbc(d) {
  if (d < 0) return 99;
  if (d < 17) return -14 - 3.7 * Math.sqrt(d / 17);
  if (d < 47) return -17.7 + 0.065 * (d - 17);
  return -15.75 + 0.0185 * (d - 47);
}
// colour temperature: hot at first, cooling through the plateau; the nebular phase is dominated by H-alpha
function colorAt(d, ibc) {
  const T = d < 20 ? 12000 - 300 * d : d < 110 ? 6000 - 8 * (d - 20) : 4500;
  const c = bbColor(T); const neb = Math.min(1, Math.max(0, (d - 110) / 60)) * (ibc ? 0.3 : 0.6);
  const r = [c[0] * (1 - neb) + 1.0 * neb, c[1] * (1 - neb) + 0.32 * neb, c[2] * (1 - neb) + 0.3 * neb];
  const y = 0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2]; return [r[0] / y, r[1] / y, r[2] / y];
}
// cumulative light (flux of absolute magnitude 0 times days) for frame averaging
const N = 4000, cumIIP = new Float64Array(N + 1), cumIbc = new Float64Array(N + 1);
for (let i = 1; i <= N; i++) {
  cumIIP[i] = cumIIP[i - 1] + 0.5 * (10 ** (-0.4 * magIIP(i - 1)) + 10 ** (-0.4 * magIIP(i)));
  cumIbc[i] = cumIbc[i - 1] + 0.5 * (10 ** (-0.4 * magIbc(i - 1)) + 10 ** (-0.4 * magIbc(i)));
}
const cumAt = (tab, d) => d <= 0 ? 0 : d >= N ? tab[N] : tab[Math.floor(d)] + (tab[Math.floor(d) + 1] - tab[Math.floor(d)]) * (d - Math.floor(d));
// mean flux (absolute magnitude 0 units) seen between ts - win and ts (years since the light arrived)
function meanFlux(ts, win, ibc) {
  const tab = ibc ? cumIbc : cumIIP, mag = ibc ? magIbc : magIIP;
  const d1 = ts * 365.25, d0 = (ts - win) * 365.25;
  if (win * 365.25 < 0.05) return 10 ** (-0.4 * mag(d1));
  return (cumAt(tab, d1) - cumAt(tab, d0)) / (d1 - d0);
}

// real stars with predicted explosions. tObs: years after J2000 when the light reaches the Sun (estimates)
export const SCHEDULED = [
  { name: 'Betelgeuse', tObs: 1e5 },
  { name: 'Antares', tObs: 6e5 },
];

const remnantCache = new Map();
function remnant(key, pos, age, seed) {
  // radius: free expansion at ~5,000 km/s, then the Sedov-Taylor blast wave R = 12.5 pc (t / 10^4 yr)^0.4
  const rf = 5.1e-3 * age, rs = 12.5 * Math.pow(age / 1e4, 0.4), R = 1 / Math.sqrt(1 / (rf * rf) + 1 / (rs * rs));
  let nb = remnantCache.get(key);
  if (!nb) { nb = { pos, radius: R, type: 2, seed, colA: [1.0, 0.35, 0.3], colB: [0.3, 0.75, 1.0], name: 'Supernova remnant' }; remnantCache.set(key, nb); if (remnantCache.size > 200) remnantCache.delete(remnantCache.keys().next().value); }
  nb.pos = pos; nb.radius = Math.max(R, 0.002);
  // surface brightness: bright while young, fading as the shell sweeps up gas and cools
  nb.lum = 70 * Math.pow(Math.max(age, 100) / 1000, -0.3) * Math.exp(-age / 6e4);
  return nb;
}

// Per frame: find supernovae visible from the camera. Returns {points: [...], remnants: [...]} and marks dead
// catalogue stars on the field.
export function updateSupernovae(field, camLocal, gq) {
  const out = { points: [], remnants: [] };
  if (!field) return out;
  const tyr = world.tyr, win = Math.abs(world.dtyr) || 0, q = [0, 0, 0];
  // procedural progenitors in loaded cells
  for (const cell of field.cells.values()) {
    if (!cell.prog || !cell.prog.length) continue;
    field.cellPhase(cell);
    const d = cell.data;
    for (const i of cell.prog) {
      const k = snClassOf(d[i * 5 + 3], Math.abs(d[i * 5 + 4])); if (k < 0) continue;
      const tau = SN_CLASSES[k].tau, h = cell.vel[i * 4 + 3];
      field.posOf(cell, i, q);
      const rx = q[0] - camLocal[0], ry = q[1] - camLocal[1], rz = q[2] - camLocal[2], dist = Math.hypot(rx, ry, rz);
      let ph = tyr / tau + h - dist * LY_PER_PC / tau; ph -= Math.floor(ph);
      if (ph < SN_LIVE) continue;
      const ts = (ph - SN_LIVE) * tau;          // years since the explosion's light reached the camera
      const ibc = k === 0;
      if (ts < 12 + win) {
        const f = meanFlux(ts, Math.min(win, ts + 12), ibc) / Math.max(dist * dist, 1e-12) * 100;   // flux of the abs. mag. 0 source at 10 pc
        const m = -2.5 * Math.log10(Math.max(f, 1e-30));
        if (m < 9) out.points.push({ dir: Q.rot(gq, [rx, ry, rz]), color: colorAt(ts * 365.25, ibc), flux: Math.exp(-0.9210340372 * (m + 26.74)), m, dist, key: cell.b + ':' + cell.cx + ':' + cell.cy + ':' + cell.cz + ':' + i });
      }
      if (ts < 1.2e5 && dist < 2500) out.remnants.push(remnant(cell.b + ':' + cell.cx + ':' + cell.cy + ':' + cell.cz + ':' + i, q.slice(), Math.max(ts, 0.01) + dist * 0, (h * 50) % 50));
    }
  }
  // scheduled explosions of real stars
  const cc = field.cells.get('catalog'), dead = field.deadCat || (field.deadCat = new Set());
  dead.clear(); field.deadList = [-1, -1, -1, -1];
  if (cc && catalog.ready) {
    field.cellPhase(cc);
    SCHEDULED.forEach((sn, j) => {
      if (sn.i === undefined) { const n = catalog.named.find(x => x.name === sn.name); sn.i = n ? n.i : -1; }
      if (sn.i < 0) return;
      // emission time: the light reaches the Sun at tObs
      if (sn.tEm === undefined) {
        const d = catalog.data, v = catalog.vel, k = KMS_PCYR * sn.tObs, i = sn.i;
        const sd = Math.hypot(d[i * 5] + v[i * 4] * k, d[i * 5 + 1] + v[i * 4 + 1] * k, d[i * 5 + 2] + v[i * 4 + 2] * k);   // distance when the light arrives
        sn.tEm = sn.tObs - sd * LY_PER_PC;
      }
      // the star (and its remnant) keep moving with the star's velocity
      const sv = { cell: cc }; const realTyr = world.tyr;
      field.posOf(cc, sn.i, q);
      const rx = q[0] - camLocal[0], ry = q[1] - camLocal[1], rz = q[2] - camLocal[2], dist = Math.hypot(rx, ry, rz);
      const ts = realTyr - sn.tEm - dist * LY_PER_PC;
      if (ts < 0) return;
      dead.add(sn.i); field.deadList[j] = sn.i;
      if (ts < 12 + win) {
        const f = meanFlux(ts, Math.min(win, ts + 12), false) / Math.max(dist * dist, 1e-12) * 100;
        const m = -2.5 * Math.log10(Math.max(f, 1e-30));
        out.points.push({ dir: Q.rot(gq, [rx, ry, rz]), color: colorAt(ts * 365.25, false), flux: Math.exp(-0.9210340372 * (m + 26.74)), m, dist, name: sn.name });
      }
      if (ts < 2e5) { const nb = remnant('cat:' + sn.i, q.slice(), Math.max(ts, 0.01), 1.3 + j); nb.name = sn.name + ' supernova remnant'; out.remnants.push(nb); }
    });
  }
  out.points.sort((a, b) => a.m - b.m);
  if (out.points.length > 64) out.points.length = 64;
  return out;
}
function snClassOf(MV, T) {
  if (!(MV < -1.2 && (T > 15000 || MV < -4.5))) return -1;
  return MV < -5.5 ? 0 : MV < -4.5 ? 1 : MV < -3.5 ? 2 : MV < -2.5 ? 3 : MV < -1.6 ? 4 : 5;
}
