// Procedural stars of one galaxy: magnitude binned grids of cells generated on demand around the camera.
import { gl, makeVAO } from './gl.js';
import { RNG, hashCombine } from './rng.js';
import { LF, LF_MIN, YOUNG, makeStar, starFromCatalog } from './stars.js';
import { catalog } from './assets.js';
import { makeDensityFn, SUN_POS } from './universe.js';

const NB = LF.length;
export const STAR_MLIM = 8.8;     // apparent magnitude to which stars are instantiated
const MAX_PER_CELL = 2500;

export class StarField {
  constructor(galaxy) {
    this.g = galaxy;
    this.dens = makeDensityFn(galaxy);
    this.cells = new Map();
    this.bins = [];
    for (let b = 0; b < NB; b++) {
      const M = LF_MIN + b + 0.5;
      const d = Math.pow(10, (STAR_MLIM - M + 5) / 5);
      const size = Math.pow(2, Math.round(Math.log2(d / 1.6)));
      this.bins.push({ M, d, size });
    }
    this.fixed = [];  // hand placed stars {pos, MV, T, system}
    this.frame = 0;
    this.pending = [];
  }

  cellKey(b, x, y, z) { return b + ':' + x + ':' + y + ':' + z; }

  genCell(b, cx, cy, cz) {
    const bin = this.bins[b], s = bin.size, g = this.g;
    const rng = new RNG(hashCombine(g.seed, 0x57a7, b, cx, cy, cz));
    const o = [cx * s, cy * s, cz * s];
    const d = [0, 0], p = [0, 0, 0];
    const fy = YOUNG[b], phi = LF[b];
    // estimate max density over the cell
    let dmax = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 5; j++) for (let k = 0; k < 3; k++) {
      p[0] = o[0] + s * i / 2; p[1] = o[1] + s * j / 4; p[2] = o[2] + s * k / 2; this.dens(p, d);
      const v = d[0] * (1 - fy) + d[1] * fy; if (v > dmax) dmax = v;
    }
    dmax *= 1.3;
    let n = rng.poisson(Math.min(phi * dmax * s * s * s, 4 * MAX_PER_CELL));
    let thin = 1;
    if (n > MAX_PER_CELL) { thin = MAX_PER_CELL / n; n = MAX_PER_CELL; }
    const data = new Float32Array(n * 5), aux = new Float32Array(n * 3);
    let m = 0;
    for (let i = 0; i < n; i++) {
      const x = rng.f() * s, y = rng.f() * s, z = rng.f() * s, u = rng.f(), u1 = rng.f(), u2 = rng.f(), um = rng.f();
      p[0] = o[0] + x; p[1] = o[1] + y; p[2] = o[2] + z; this.dens(p, d);
      const dy = d[1] * fy, dt = d[0] * (1 - fy) + dy;
      if (u * dmax > dt) continue;
      const young = (u * dmax) < dy;
      const MV = LF_MIN + b + um;
      if (this.catalogCenter) {
        // the real catalogue is complete to about magnitude 8.5 around the Sun: no procedural stars there
        const cx = p[0] - this.catalogCenter[0], cy = p[1] - this.catalogCenter[1], cz = p[2] - this.catalogCenter[2];
        if (cx * cx + cy * cy + cz * cz < Math.pow(10, (8.5 - MV + 5) / 2.5)) continue;
      }
      const st = makeStar(MV, u1, u2, young);
      // compensate thinning in dense regions by brightening (keeps integrated light)
      data[m * 5] = x; data[m * 5 + 1] = y; data[m * 5 + 2] = z; data[m * 5 + 3] = MV - 2.5 * Math.log10(1 / thin) * 0.0; data[m * 5 + 4] = st.kind >= 4 ? (st.kind === 4 ? 30000 : 2000) : st.T;
      aux[m * 3] = u1; aux[m * 3 + 1] = u2; aux[m * 3 + 2] = young ? 1 : 0;
      m++;
    }
    const cell = { b, cx, cy, cz, origin: o, n: m, data: data.subarray(0, m * 5), aux, last: this.frame, vao: null };
    if (m > 0) cell.vao = makeVAO([{ data: cell.data, stride: 20, parts: [{ loc: 0, size: 3, offset: 0 }, { loc: 1, size: 2, offset: 12 }] }]);
    return cell;
  }

  // cam: camera position in galaxy local frame (pc). Queue and generate cells within range.
  update(cam, budgetMs = 4) {
    this.frame++;
    const want = [];
    const dd = [0, 0];
    this.dens(cam, dd);
    for (let b = 0; b < NB; b++) {
      const bin = this.bins[b], s = bin.size;
      // In dense regions shrink the loading radius so star counts stay bounded
      const localN = LF[b] * (dd[0] * (1 - YOUNG[b]) + dd[1] * YOUNG[b]) * 4.19 * bin.d ** 3;
      let r = bin.d;
      if (localN > 30000) r = bin.d * Math.cbrt(30000 / localN);
      r = Math.max(r, s * 0.75);
      bin.r = r;
      const x0 = Math.floor((cam[0] - r) / s), x1 = Math.floor((cam[0] + r) / s);
      const y0 = Math.floor((cam[1] - r) / s), y1 = Math.floor((cam[1] + r) / s);
      const z0 = Math.floor((cam[2] - r) / s), z1 = Math.floor((cam[2] + r) / s);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 400) continue;
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        // sphere / box test
        const nx = Math.max(x * s, Math.min(cam[0], (x + 1) * s)) - cam[0], ny = Math.max(y * s, Math.min(cam[1], (y + 1) * s)) - cam[1], nz = Math.max(z * s, Math.min(cam[2], (z + 1) * s)) - cam[2];
        const d2 = nx * nx + ny * ny + nz * nz;
        if (d2 > r * r) continue;
        const key = this.cellKey(b, x, y, z);
        const c = this.cells.get(key);
        if (c) c.last = this.frame; else want.push({ key, b, x, y, z, d2: d2 / (s * s) });
      }
    }
    want.sort((a, b2) => a.d2 - b2.d2);
    const t0 = performance.now();
    let made = 0;
    for (const w of want) {
      if (performance.now() - t0 > budgetMs && made > 0) break;
      this.cells.set(w.key, this.genCell(w.b, w.x, w.y, w.z)); made++;
    }
    this.busy = want.length - made;
    // evict
    if (this.frame % 30 === 0) for (const [k, c] of this.cells) if (this.frame - c.last > 120) { if (c.vao) c.vao.free(); this.cells.delete(k); }
  }

  dispose() { for (const c of this.cells.values()) if (c.vao) c.vao.free(); this.cells.clear(); }

  starAt(cell, i) {
    if (cell.catalog) {
      const d = cell.data, n = catalog.byIndex.get(i);
      return { galaxy: this.g, seed: hashCombine(this.g.seed, 0xca7, i), pos: [cell.origin[0] + d[i * 5], cell.origin[1] + d[i * 5 + 1], cell.origin[2] + d[i * 5 + 2]],
        star: starFromCatalog(d[i * 5 + 3], d[i * 5 + 4], n && n.spect), key: this.g.id + '/cat:' + i, name: n ? n.name : 'HYG ' + (i + 1), catIndex: i, named: n || null };
    }
    const d = cell.data, a = cell.aux;
    const star = makeStar(d[i * 5 + 3], a[i * 3], a[i * 3 + 1], a[i * 3 + 2] > 0.5);
    return {
      galaxy: this.g, seed: hashCombine(this.g.seed, cell.b, cell.cx, cell.cy, cell.cz, i),
      pos: [cell.origin[0] + d[i * 5], cell.origin[1] + d[i * 5 + 1], cell.origin[2] + d[i * 5 + 2]], star,
      key: this.g.id + '/' + cell.b + ':' + cell.cx + ':' + cell.cy + ':' + cell.cz + ':' + i,
    };
  }

  // Find best star near a ray (local frame). Returns descriptor or null. Scores by angular distance and brightness.
  pick(cam, dir, maxAng) {
    let best = null, bestScore = 1e9;
    const cosMax = Math.cos(maxAng);
    const test = (px, py, pz, MV, cell, i, fixed) => {
      const x = px - cam[0], y = py - cam[1], z = pz - cam[2];
      const d = Math.hypot(x, y, z); if (d < 1e-9) return;
      const c = (x * dir[0] + y * dir[1] + z * dir[2]) / d;
      if (c < cosMax) return;
      const m = MV + 5 * Math.log10(d) - 5;
      if (m > STAR_MLIM + 1.5) return;
      const ang = Math.acos(Math.min(1, c));
      const score = ang / maxAng * 6 + m * 0.35;
      if (score < bestScore) { bestScore = score; best = { cell, i, fixed, d }; }
    };
    for (const f of this.fixed) test(f.pos[0], f.pos[1], f.pos[2], f.MV, null, 0, f);
    for (const cell of this.cells.values()) {
      if (cell.fixedCell && !cell.catalog) continue;
      const s = cell.catalog ? 1e6 : this.bins[cell.b].size, o = cell.origin, dt = cell.data;
      // quick reject: cell bounding sphere vs cone
      const cx = o[0] + s / 2 - cam[0], cy = o[1] + s / 2 - cam[1], cz = o[2] + s / 2 - cam[2];
      const cd = Math.hypot(cx, cy, cz), rad = s * 0.87;
      if (cd > rad) { const c = (cx * dir[0] + cy * dir[1] + cz * dir[2]) / cd; const a = Math.acos(Math.max(-1, Math.min(1, c))); if (a > maxAng + Math.asin(Math.min(1, rad / cd))) continue; }
      for (let i = 0; i < cell.n; i++) test(o[0] + dt[i * 5], o[1] + dt[i * 5 + 1], o[2] + dt[i * 5 + 2], dt[i * 5 + 3], cell, i, null);
    }
    if (!best) return null;
    if (best.fixed) return best.fixed.desc;
    return this.starAt(best.cell, best.i);
  }

  // nearest star to camera within maxDist (pc)
  nearest(cam, maxDist) {
    let best = null, bd = maxDist;
    for (const f of this.fixed) { const d = Math.hypot(f.pos[0] - cam[0], f.pos[1] - cam[1], f.pos[2] - cam[2]); if (d < bd) { bd = d; best = { fixed: f }; } }
    for (const cell of this.cells.values()) {
      if (cell.fixedCell && !cell.catalog) continue;
      const s = cell.catalog ? 1e6 : this.bins[cell.b].size, o = cell.origin;
      if (!cell.catalog && (cam[0] < o[0] - bd || cam[0] > o[0] + s + bd || cam[1] < o[1] - bd || cam[1] > o[1] + s + bd || cam[2] < o[2] - bd || cam[2] > o[2] + s + bd)) continue;
      const dt = cell.data;
      for (let i = 0; i < cell.n; i++) {
        const d = Math.hypot(o[0] + dt[i * 5] - cam[0], o[1] + dt[i * 5 + 1] - cam[1], o[2] + dt[i * 5 + 2] - cam[2]);
        if (d < bd) { bd = d; best = { cell, i }; }
      }
    }
    if (!best) return null;
    const desc = best.fixed ? best.fixed.desc : this.starAt(best.cell, best.i);
    desc.dist = bd;
    return desc;
  }
}

export function sunDescriptor(galaxy) {
  return { galaxy, seed: 0x501, pos: SUN_POS.slice(), key: galaxy.id + '/Sol', sol: true, star: makeStar(4.83, 0.9, 0.5, false) };
}
