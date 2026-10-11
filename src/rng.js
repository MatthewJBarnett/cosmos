// Deterministic hashing and random streams.
export function hash32(a) {
  a = (a ^ 61) ^ (a >>> 16); a = (a + (a << 3)) | 0; a ^= a >>> 4; a = Math.imul(a, 0x27d4eb2d); a ^= a >>> 15;
  return a >>> 0;
}
export function hashCombine(...xs) {
  let h = 0x9e3779b9;
  for (const x of xs) { h ^= hash32((x | 0) + 0x7f4a7c15 + (h << 6) + (h >>> 2)); h = Math.imul(h, 0x85ebca6b) ^ (h >>> 13); }
  return h >>> 0;
}
export function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

export class RNG {
  constructor(seed) { this.s = (seed >>> 0) || 0x1234567; }
  u32() { let t = (this.s += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (t ^ (t >>> 14)) >>> 0; }
  f() { return this.u32() / 4294967296; }
  range(a, b) { return a + (b - a) * this.f(); }
  int(a, b) { return a + Math.floor(this.f() * (b - a + 1)); }
  chance(p) { return this.f() < p; }
  gauss() { let u = 0, v = 0; while (u === 0) u = this.f(); v = this.f(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  logRange(a, b) { return Math.exp(this.range(Math.log(a), Math.log(b))); }
  pick(arr) { return arr[Math.floor(this.f() * arr.length)]; }
  weighted(ws) { let t = 0; for (const w of ws) t += w; let r = this.f() * t; for (let i = 0; i < ws.length; i++) { r -= ws[i]; if (r <= 0) return i; } return ws.length - 1; }
  dir() { const z = this.range(-1, 1), a = this.range(0, 2 * Math.PI), r = Math.sqrt(1 - z * z); return [r * Math.cos(a), r * Math.sin(a), z]; }
  poisson(lambda) {
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * this.gauss()));
    const L = Math.exp(-lambda); let k = 0, p = 1; do { k++; p *= this.f(); } while (p > L); return k - 1;
  }
}

const SYL_A = ['a', 'e', 'i', 'o', 'u', 'ae', 'ia', 'ei', 'ou', 'y'];
const SYL_C = ['b', 'c', 'd', 'f', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'z', 'th', 'sh', 'ch', 'kr', 'tr', 'dr', 'st', 'br', 'gl', 'ph', 'x', 'q'];
const SYL_E = ['n', 'r', 's', 'x', 'l', 'th', 'm', 'ra', 'on', 'us', 'is', 'ar', 'el', 'a', 'os', 'ia', 'ion'];
export function makeName(seed) {
  const r = new RNG(seed ^ 0xabc123);
  const n = r.int(2, 3); let s = '';
  for (let i = 0; i < n; i++) { if (i > 0 || r.chance(0.8)) s += r.pick(SYL_C); s += r.pick(SYL_A); }
  if (r.chance(0.7)) s += r.pick(SYL_E);
  return s[0].toUpperCase() + s.slice(1);
}
