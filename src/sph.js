// Smoothed-particle hydrodynamics for a giant impact (the Moon-forming collision). Equal-mass particles; cubic spline
// kernel with adaptive smoothing lengths; a stiff rock equation of state that resists compression but has no tension
// (P = c0^2 (rho - rho0) when compressed, plus the thermal pressure (gamma - 1) rho u of shock-heated rock and vapour);
// Monaghan artificial viscosity to capture the shocks; direct-sum gravity softened over the smoothing length; leapfrog
// time steps limited by the signal speed. A few thousand particles: coarse next to research runs (10^5-10^8 particles,
// Tillotson or ANEOS equations of state), but the same physics: the impactor shears along the target, an arm of mantle
// is thrown ahead, winds up and collapses into a hot disk around a molten, fast-spinning Earth.
const G = 6.674e-11;
// cubic spline kernel W(r, h) (support 2h) and its derivative dW/dr / r
function W(r, h) { const q = r / h, s = 1 / (Math.PI * h * h * h); if (q < 1) return s * (1 - 1.5 * q * q + 0.75 * q * q * q); if (q < 2) { const e = 2 - q; return s * 0.25 * e * e * e; } return 0; }
function dWr(r, h) { const q = r / h, h2 = h * h, s = 1 / (Math.PI * h2 * h2 * h); if (q < 1) return s * (-3 + 2.25 * q); if (q < 2) { const e = 2 - q; return -s * 0.75 * e * e / Math.max(q, 1e-9); } return 0; }
export const SPH_MAT = { EARTH: 0, THEIA: 1 };

export class SPH {
  constructor(n) {
    this.n = n; this.t = 0; this.steps = 0;
    this.x = new Float64Array(n * 3); this.v = new Float64Array(n * 3); this.a = new Float64Array(n * 3);
    this.u = new Float64Array(n); this.du = new Float64Array(n); this.rho = new Float64Array(n); this.P = new Float64Array(n); this.cs = new Float64Array(n);
    this.h = new Float64Array(n); this.m = new Float64Array(n); this.mat = new Uint8Array(n); this.rho0 = new Float64Array(n);
    this.c0 = 7000; this.gamma = 1.4; this.alpha = 1; this.beta = 2; this.selfOnly = false;
  }
  // particles on a cubic lattice inside a sphere (jittered a little), with total mass M
  static sphere(M, R, n, mat, seed = 1) {
    const s = Math.cbrt(4 / 3 * Math.PI * R ** 3 / n), pts = [];
    let rs = seed; const rnd = () => { rs = (Math.imul(rs, 1103515245) + 12345) >>> 0; return rs / 4294967296 - 0.5; };
    const k = Math.ceil(R / s) + 1;
    for (let i = -k; i <= k; i++) for (let j = -k; j <= k; j++) for (let l = -k; l <= k; l++) {
      const p = [(i + 0.5 * (j & 1)) * s + rnd() * 0.1 * s, j * s * 0.95 + rnd() * 0.1 * s, (l + 0.5 * (i & 1)) * s + rnd() * 0.1 * s];
      if (Math.hypot(...p) < R) pts.push(p);
    }
    const sp = new SPH(pts.length), mp = M / pts.length, rhoMean = M / (4 / 3 * Math.PI * R ** 3);
    pts.forEach((p, i) => { sp.x.set(p, i * 3); sp.m[i] = mp; sp.mat[i] = mat; sp.h[i] = 1.3 * s; sp.rho0[i] = 0.8 * rhoMean; sp.u[i] = 0; });
    return sp;
  }
  // concatenate bodies (positions and velocities offset)
  static join(list) {
    const n = list.reduce((s, b) => s + b.sp.n, 0), out = new SPH(n); let o = 0;
    for (const { sp, x0, v0 } of list) {
      for (let i = 0; i < sp.n; i++, o++) {
        for (let k = 0; k < 3; k++) { out.x[o * 3 + k] = sp.x[i * 3 + k] + x0[k]; out.v[o * 3 + k] = sp.v[i * 3 + k] + v0[k]; }
        out.u[o] = sp.u[i]; out.h[o] = sp.h[i]; out.m[o] = sp.m[i]; out.mat[o] = sp.mat[i]; out.rho0[o] = sp.rho0[i];
      }
    }
    return out;
  }
  // neighbour grid: cells of size 2 h_max (a hash map, since ejecta fly far)
  grid() {
    let hmax = 0; for (let i = 0; i < this.n; i++) hmax = Math.max(hmax, this.h[i]);
    const cs = 2 * hmax, cells = new Map(), key = (a, b, c) => (a * 73856093) ^ (b * 19349663) ^ (c * 83492791);
    const ci = new Int32Array(this.n * 3);
    for (let i = 0; i < this.n; i++) {
      const a = Math.floor(this.x[i * 3] / cs), b = Math.floor(this.x[i * 3 + 1] / cs), c = Math.floor(this.x[i * 3 + 2] / cs);
      ci[i * 3] = a; ci[i * 3 + 1] = b; ci[i * 3 + 2] = c;
      const kk = key(a, b, c); let l = cells.get(kk); if (!l) cells.set(kk, l = []); l.push(i);
    }
    // neighbour lists (j > i only), within 2 max(h_i, h_j)
    const nb = [];
    for (let i = 0; i < this.n; i++) {
      const L = [], xi = this.x[i * 3], yi = this.x[i * 3 + 1], zi = this.x[i * 3 + 2];
      for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) for (let dc = -1; dc <= 1; dc++) {
        const l = cells.get(key(ci[i * 3] + da, ci[i * 3 + 1] + db, ci[i * 3 + 2] + dc)); if (!l) continue;
        for (const j of l) {
          if (j <= i) continue;
          const dx = xi - this.x[j * 3], dy = yi - this.x[j * 3 + 1], dz = zi - this.x[j * 3 + 2], r2 = dx * dx + dy * dy + dz * dz, hh = 2 * Math.max(this.h[i], this.h[j]);
          if (r2 < hh * hh) L.push(j);
        }
      }
      nb.push(L);
    }
    return nb;
  }
  forces() {
    const n = this.n, X = this.x, Vv = this.v, A = this.a, H = this.h, Mm = this.m;
    const nb = this.grid();
    // density (symmetrised kernel), then pressure and sound speed
    for (let i = 0; i < n; i++) this.rho[i] = Mm[i] * W(0, H[i]);
    for (let i = 0; i < n; i++) for (const j of nb[i]) {
      const dx = X[i * 3] - X[j * 3], dy = X[i * 3 + 1] - X[j * 3 + 1], dz = X[i * 3 + 2] - X[j * 3 + 2], r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      this.rho[i] += Mm[j] * W(r, H[i]); this.rho[j] += Mm[i] * W(r, H[j]);
    }
    for (let i = 0; i < n; i++) {
      const rho = this.rho[i], comp = rho > this.rho0[i];
      this.P[i] = (comp ? this.c0 * this.c0 * (rho - this.rho0[i]) : 0) + (this.gamma - 1) * rho * this.u[i];
      this.cs[i] = Math.sqrt((comp ? this.c0 * this.c0 : 0.05 * this.c0 * this.c0) + this.gamma * (this.gamma - 1) * this.u[i]);
    }
    A.fill(0); this.du.fill(0);
    // pressure forces, viscosity and heating
    let vsig = 0;
    for (let i = 0; i < n; i++) for (const j of nb[i]) {
      const dx = X[i * 3] - X[j * 3], dy = X[i * 3 + 1] - X[j * 3 + 1], dz = X[i * 3 + 2] - X[j * 3 + 2], r2 = dx * dx + dy * dy + dz * dz, r = Math.sqrt(r2);
      const dvx = Vv[i * 3] - Vv[j * 3], dvy = Vv[i * 3 + 1] - Vv[j * 3 + 1], dvz = Vv[i * 3 + 2] - Vv[j * 3 + 2], vr = dvx * dx + dvy * dy + dvz * dz;
      const hb = 0.5 * (H[i] + H[j]), gw = 0.5 * (dWr(r, H[i]) + dWr(r, H[j]));
      if (gw === 0) continue;
      let pi = 0;
      if (vr < 0) { const mu = hb * vr / (r2 + 0.01 * hb * hb), cb = 0.5 * (this.cs[i] + this.cs[j]); pi = (-this.alpha * cb * mu + this.beta * mu * mu) / (0.5 * (this.rho[i] + this.rho[j])); vsig = Math.max(vsig, cb - 2 * mu); }
      const pij = this.P[i] / (this.rho[i] ** 2) + this.P[j] / (this.rho[j] ** 2) + pi;
      const fx = pij * gw * dx, fy = pij * gw * dy, fz = pij * gw * dz;
      A[i * 3] -= Mm[j] * fx; A[i * 3 + 1] -= Mm[j] * fy; A[i * 3 + 2] -= Mm[j] * fz;
      A[j * 3] += Mm[i] * fx; A[j * 3 + 1] += Mm[i] * fy; A[j * 3 + 2] += Mm[i] * fz;
      const w = vr * gw;
      this.du[i] += Mm[j] * (this.P[i] / (this.rho[i] ** 2) + 0.5 * pi) * w;
      this.du[j] += Mm[i] * (this.P[j] / (this.rho[j] ** 2) + 0.5 * pi) * w;
    }
    // self-gravity: direct sum, softened over the smoothing length
    const selfOnly = this.selfOnly, mat = this.mat;
    for (let i = 0; i < n; i++) {
      const xi = X[i * 3], yi = X[i * 3 + 1], zi = X[i * 3 + 2], hi = H[i], mi = Mm[i], mati = mat[i]; let ax = 0, ay = 0, az = 0;
      for (let j = i + 1; j < n; j++) {
        if (selfOnly && mati !== mat[j]) continue;
        const dx = X[j * 3] - xi, dy = X[j * 3 + 1] - yi, dz = X[j * 3 + 2] - zi, e = 0.5 * (hi + H[j]);
        const r2 = dx * dx + dy * dy + dz * dz + e * e, ir3 = 1 / (r2 * Math.sqrt(r2));
        const kj = G * Mm[j] * ir3, ki = G * mi * ir3;
        ax += kj * dx; ay += kj * dy; az += kj * dz;
        A[j * 3] -= ki * dx; A[j * 3 + 1] -= ki * dy; A[j * 3 + 2] -= ki * dz;
      }
      A[i * 3] += ax; A[i * 3 + 1] += ay; A[i * 3 + 2] += az;
    }
    // time step: Courant condition on the signal speed, and the acceleration
    let dt = Infinity;
    for (let i = 0; i < n; i++) {
      const a = Math.hypot(A[i * 3], A[i * 3 + 1], A[i * 3 + 2]), v = Math.hypot(Vv[i * 3], Vv[i * 3 + 1], Vv[i * 3 + 2]);
      dt = Math.min(dt, 0.3 * H[i] / (this.cs[i] + 0.0 * v + 1.2 * Math.max(vsig - this.cs[i], 0) + 1e-9), 0.3 * Math.sqrt(H[i] / Math.max(a, 1e-12)));
    }
    return dt;
  }
  // smoothing lengths follow the density: ~50 neighbours
  updateH() { for (let i = 0; i < this.n; i++) { const hn = 1.25 * Math.cbrt(this.m[i] / Math.max(this.rho[i], 1)); this.h[i] = Math.min(Math.max(0.7 * this.h[i] + 0.3 * hn, 4e4), 2.5e6); } }
  // one leapfrog (kick-drift-kick) step; damp (0..1) removes velocity for relaxation
  step(damp = 0) {
    if (!this.dt) this.dt = Math.min(this.forces(), 60);
    const dt = this.dt, n = this.n;
    for (let i = 0; i < n * 3; i++) this.v[i] += 0.5 * dt * this.a[i];
    for (let i = 0; i < n; i++) this.u[i] = Math.max(0, this.u[i] + 0.5 * dt * this.du[i]);
    for (let i = 0; i < n * 3; i++) this.x[i] += dt * this.v[i];
    this.updateH();
    const dtn = this.forces();
    for (let i = 0; i < n * 3; i++) this.v[i] += 0.5 * dt * this.a[i];
    for (let i = 0; i < n; i++) this.u[i] = Math.max(0, this.u[i] + 0.5 * dt * this.du[i]);
    if (damp) { for (let i = 0; i < n * 3; i++) this.v[i] *= 1 - damp; this.u.fill(0); }
    this.t += dt; this.steps++;
    this.dt = Math.min(dtn, 1.3 * dt, 60);
    return dt;
  }
  // temperature (K) for display: specific heat of rock ~1,200 J/(kg K) above a ~1,300 K start (a crusted magma ocean),
  // saturating towards ~7,000 K: melting and vaporising soak up much of the shock energy (this equation of state has no
  // latent heat), and giant-impact simulations find the hot disk at ~3,000-7,000 K
  temp(i) { return 1300 + 5700 * (1 - Math.exp(-this.u[i] / (1200 * 5700))); }
}

// Main thread: starts the worker and keeps its snapshots; frame(t) interpolates between them.
export class SPHRun {
  constructor(cfg) {
    this.cfg = cfg; this.snaps = []; this.mat = null; this.status = 'starting';
    this.worker = new Worker(new URL('./sphworker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'snap') { this.snaps.push(m); this.status = ''; }
      else if (m.type === 'init') { this.mat = m.mat; this.n = m.n; this.mp = m.m; }
      else if (m.type === 'status') this.status = m.text;
      else if (m.type === 'done') this.done = true;
    };
    this.worker.postMessage({ cmd: 'start', cfg });
  }
  stop() { this.worker.postMessage({ cmd: 'stop' }); this.worker.terminate(); }
  // keep the worker computing up to 8 hours past what is being watched
  watch(t) { if (t + 8 * 3600 > (this._ahead || 0) + 1800) { this._ahead = t + 8 * 3600; this.worker.postMessage({ cmd: 'ahead', t: this._ahead }); } }
  get latest() { return this.snaps.length ? this.snaps[this.snaps.length - 1].t : -1; }
  // positions and temperatures at time t (linear between snapshots)
  frame(t) {
    const S = this.snaps; if (!S.length) return null;
    let i = S.length - 1; while (i > 0 && S[i].t > t) i--;
    const a = S[i], b = S[Math.min(i + 1, S.length - 1)], k = b.t > a.t ? Math.min(Math.max((t - a.t) / (b.t - a.t), 0), 1) : 0;
    if (this._f && this._f.a === a && this._f.k === k) return this._f;
    const n = a.T.length, x = new Float32Array(n * 3), T = new Float32Array(n);
    for (let j = 0; j < n * 3; j++) x[j] = a.x[j] + (b.x[j] - a.x[j]) * k;
    for (let j = 0; j < n; j++) T[j] = a.T[j] + (b.T[j] - a.T[j]) * k;
    return (this._f = { a, k, x, T, t, n });
  }
}
