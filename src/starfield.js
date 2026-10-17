// Procedural stars of one galaxy: magnitude binned grids of cells generated on demand around the camera.
import { gl, makeVAO } from './gl.js';
import { RNG, hashCombine } from './rng.js';
import { LF, LF_MIN, YOUNG, makeStar, starFromCatalog, bcOfT } from './stars.js';
import { sunState } from './evolution.js';
import { catalog } from './assets.js';
import { makeDensityFn, SUN_POS } from './universe.js';
import { VQ, streamVel, wrapPhase, world, snClass, descPosP } from './galdyn.js';

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
    const data = new Float32Array(n * 5), aux = new Float32Array(n * 3), vel = new Float32Array(n * 4);
    const sv = streamVel([o[0] + s / 2, o[1] + s / 2, o[2] + s / 2]), rv = new RNG(hashCombine(g.seed, 0x7e10, b, cx, cy, cz));
    const prog = [];
    let m = 0;
    for (let i = 0; i < n; i++) {
      const x = rng.f() * s, y = rng.f() * s, z = rng.f() * s, u = rng.f(), u1 = rng.f(), u2 = rng.f(), um = rng.f();
      p[0] = o[0] + x; p[1] = o[1] + y; p[2] = o[2] + z; this.dens(p, d);
      const dy = d[1] * fy, dt = d[0] * (1 - fy) + dy;
      if (u * dmax > dt) continue;
      const young = (u * dmax) < dy;
      const MV = LF_MIN + b + um;
      // the real catalogue is complete to about magnitude 8.5 around the Sun: procedural stars there are flagged and
      // only shown once the catalogue has faded (millions of years from now)
      let supp = false;
      if (this.catalogCenter) {
        const cx = p[0] - this.catalogCenter[0], cy = p[1] - this.catalogCenter[1], cz = p[2] - this.catalogCenter[2];
        supp = cx * cx + cy * cy + cz * cz < Math.pow(10, (8.5 - MV + 5) / 2.5);
      }
      const st = makeStar(MV, u1, u2, young);
      // velocity: circular streaming through the spiral pattern plus random motion (young stars are kinematically cold)
      const sg = young ? 7 : 22;
      vel[m * 4] = Math.round((sv[0] + rv.gauss() * sg) / VQ); vel[m * 4 + 1] = Math.round(rv.gauss() * sg * 0.6 / VQ); vel[m * 4 + 2] = Math.round((sv[2] + rv.gauss() * sg * 0.8) / VQ);
      vel[m * 4 + 3] = rv.f();
      // compensate thinning in dense regions by brightening (keeps integrated light)
      const T = st.kind >= 4 ? (st.kind === 4 ? 30000 : 2000) : st.T;
      data[m * 5] = x; data[m * 5 + 1] = y; data[m * 5 + 2] = z; data[m * 5 + 3] = MV; data[m * 5 + 4] = supp ? -T : T;
      aux[m * 3] = u1; aux[m * 3 + 1] = u2; aux[m * 3 + 2] = young ? 1 : 0;
      if (snClass(MV, T) >= 0) prog.push(m);
      m++;
    }
    const cell = { b, cx, cy, cz, origin: o, size: s, n: m, data: data.subarray(0, m * 5), vel: vel.subarray(0, m * 4), aux, prog, last: this.frame, vao: null };
    if (m > 0) cell.vao = makeVAO([{ data: cell.data, stride: 20, parts: [{ loc: 0, size: 3, offset: 0 }, { loc: 1, size: 2, offset: 12 }] }, { data: cell.vel, stride: 16, parts: [{ loc: 2, size: 4, offset: 0 }] }]);
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
    // (also when racing through the field at high time rates: keep the number of cells bounded)
    const crowded = this.cells.size > 5000;
    if (this.frame % 30 === 0 || crowded) for (const [k, c] of this.cells) if (this.frame - c.last > (crowded ? 2 : 120)) { if (c.vao) c.vao.free(); this.cells.delete(k); }
  }

  dispose() { for (const c of this.cells.values()) if (c.vao) c.vao.free(); this.cells.clear(); }

  // current position (pattern frame) of star i of a cell. cellPhase(cell) must be evaluated first for procedural cells.
  cellPhase(cell) {
    if (cell.catalog) { const sI = world.sunI, k = world.catK; cell._k = k; cell._sun = sI; cell._rot = world.rotP; cell._w = world.catW; return; }
    cell._ph = cell.size ? wrapPhase(cell.size, world.tyr) : 0;
  }
  posOf(cell, i, out) {
    const d = cell.data;
    if (cell.catalog) {
      const v = catalog.vel, k = cell._k, s = cell._sun, r = cell._rot;
      const x = s[0] + d[i * 5] + v[i * 4] * k, y = s[1] + d[i * 5 + 1] + v[i * 4 + 1] * k, z = s[2] + d[i * 5 + 2] + v[i * 4 + 2] * k;
      out[0] = r[0] * x + r[3] * y + r[6] * z; out[1] = y; out[2] = r[2] * x + r[5] * y + r[8] * z;
      return out;
    }
    const o = cell.origin;
    if (!cell.vel || !cell._ph) { out[0] = o[0] + d[i * 5]; out[1] = o[1] + d[i * 5 + 1]; out[2] = o[2] + d[i * 5 + 2]; return out; }
    const s = cell.size, ph = cell._ph, v = cell.vel;
    for (let a = 0; a < 3; a++) { const u = d[i * 5 + a] + v[i * 4 + a] * ph; out[a] = o[a] + u - s * Math.floor(u / s); }
    return out;
  }
  // is star i currently shining (catalogue fading, suppressed procedural stars, dead massive stars)?
  visible(cell, i) {
    // (exploded catalogue stars stay reachable: their systems hold the remnant)
    if (cell.catalog) return cell._w > 0.02;
    const T = cell.data[i * 5 + 4];
    if (T < 0 && world.catW > 0.98) return false;
    return true;
  }
  starAt(cell, i) {
    this.cellPhase(cell);
    const pos = this.posOf(cell, i, [0, 0, 0]);
    if (cell.catalog) {
      const d = cell.data, n = catalog.byIndex.get(i), v = catalog.vel;
      return { galaxy: this.g, seed: hashCombine(this.g.seed, 0xca7, i), pos, motion: { type: 'cat', prel: [d[i * 5], d[i * 5 + 1], d[i * 5 + 2]], vel: [v[i * 4], v[i * 4 + 1], v[i * 4 + 2]] },
        star: starFromCatalog(d[i * 5 + 3], d[i * 5 + 4], n && n.spect), key: this.g.id + '/cat:' + i, name: n ? n.name : 'HYG ' + (i + 1), catIndex: i, named: n || null };
    }
    const d = cell.data, a = cell.aux;
    const star = makeStar(d[i * 5 + 3], a[i * 3], a[i * 3 + 1], a[i * 3 + 2] > 0.5);
    const motion = cell.vel ? { type: 'wrap', o: cell.origin, s: cell.size, x: [d[i * 5], d[i * 5 + 1], d[i * 5 + 2]], k: [cell.vel[i * 4], cell.vel[i * 4 + 1], cell.vel[i * 4 + 2]] } : null;
    return {
      galaxy: this.g, seed: hashCombine(this.g.seed, cell.b, cell.cx, cell.cy, cell.cz, i),
      pos, motion, star,
      key: this.g.id + '/' + cell.b + ':' + cell.cx + ':' + cell.cy + ':' + cell.cz + ':' + i,
    };
  }

  // Find best star near a ray (local frame). Returns descriptor or null. Scores by angular distance and brightness.
  pick(cam, dir, maxAng) {
    let best = null, bestScore = 1e9;
    const cosMax = Math.cos(maxAng), q = [0, 0, 0];
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
    for (const f of this.fixed) if (!f.hidden) test(f.pos[0], f.pos[1], f.pos[2], f.MV, null, 0, f);
    for (const cell of this.cells.values()) {
      if (cell.fixedCell && !cell.catalog) continue;
      this.cellPhase(cell);
      if (cell.catalog && cell._w < 0.02) continue;
      const s = cell.catalog ? 1e6 : this.bins[cell.b].size, o = cell.catalog ? world.sunP : cell.origin, dt = cell.data;
      // quick reject: cell bounding sphere vs cone
      const cx = o[0] + s / 2 - cam[0], cy = o[1] + s / 2 - cam[1], cz = o[2] + s / 2 - cam[2];
      const cd = Math.hypot(cx, cy, cz), rad = s * 0.87;
      if (cd > rad) { const c = (cx * dir[0] + cy * dir[1] + cz * dir[2]) / cd; const a = Math.acos(Math.max(-1, Math.min(1, c))); if (a > maxAng + Math.asin(Math.min(1, rad / cd))) continue; }
      for (let i = 0; i < cell.n; i++) { if (!this.visible(cell, i)) continue; this.posOf(cell, i, q); test(q[0], q[1], q[2], dt[i * 5 + 3], cell, i, null); }
    }
    if (!best) return null;
    if (best.fixed) return best.fixed.desc;
    return this.starAt(best.cell, best.i);
  }

  // nearest star to camera within maxDist (pc)
  nearest(cam, maxDist) {
    let best = null, bd = maxDist;
    const q = [0, 0, 0];
    for (const f of this.fixed) { if (f.hidden) continue; const d = Math.hypot(f.pos[0] - cam[0], f.pos[1] - cam[1], f.pos[2] - cam[2]); if (d < bd) { bd = d; best = { fixed: f }; } }
    for (const cell of this.cells.values()) {
      if (cell.fixedCell && !cell.catalog) continue;
      const s = cell.catalog ? 1e6 : this.bins[cell.b].size, o = cell.origin;
      if (!cell.catalog && (cam[0] < o[0] - bd || cam[0] > o[0] + s + bd || cam[1] < o[1] - bd || cam[1] > o[1] + s + bd || cam[2] < o[2] - bd || cam[2] > o[2] + s + bd)) continue;
      this.cellPhase(cell);
      if (cell.catalog && cell._w < 0.02) continue;
      for (let i = 0; i < cell.n; i++) {
        this.posOf(cell, i, q);
        const d = Math.hypot(q[0] - cam[0], q[1] - cam[1], q[2] - cam[2]);
        if (d < bd && this.visible(cell, i)) { bd = d; best = { cell, i }; }
      }
    }
    if (!best) return null;
    const desc = best.fixed ? best.fixed.desc : this.starAt(best.cell, best.i);
    desc.dist = bd;
    return desc;
  }
  // move the hand placed stars (Sun, nearby stars with planets, ...) to where they are now
  updateFixed() {
    for (const f of this.fixed) {
      f.pos = descPosP(f.desc); if (f.cell) f.cell.origin = f.pos;
      // nearby stars with measured velocities move in straight lines, valid for a few million years like the catalogue
      f.hidden = f.desc.motion && f.desc.motion.type === 'cat' && world.catW < 0.02; if (f.cell) f.cell.hidden = f.hidden;
      // the Sun as a star seen from afar changes as it evolves (red giant, white dwarf)
      if (f.desc.sol && f.cell && f.cell.vao) {
        const st = sunState(world.tyr), MV = 4.83 - 2.5 * Math.log10(st.L) - (bcOfT(st.T) - bcOfT(5772)), T = st.T;
        if (Math.abs(MV - f.cell.data[3]) > 0.02 || Math.abs(T - f.cell.data[4]) > 20) {
          f.cell.data[3] = MV; f.cell.data[4] = T; f.MV = MV;
          gl.bindBuffer(gl.ARRAY_BUFFER, f.cell.vao.bufs[0]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, f.cell.data);
        }
      }
    }
  }
}

export function sunDescriptor(galaxy) {
  return { galaxy, seed: 0x501, pos: SUN_POS.slice(), motion: { type: 'sol' }, key: galaxy.id + '/Sol', sol: true, star: makeStar(4.83, 0.9, 0.5, false) };
}
