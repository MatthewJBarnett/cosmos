// Runs the giant-impact SPH off the main thread and streams snapshots back (see sph.js).
import { SPH } from './sph.js';
let sim = null, stopped = false, nextSnap = 0, tMax = 0;
const snapEvery = (t) => t < 6 * 3600 ? 120 : t < 24 * 3600 ? 600 : 1800;
function snap() {
  const n = sim.n, x = new Float32Array(n * 3), T = new Float32Array(n);
  for (let i = 0; i < n * 3; i++) x[i] = sim.x[i];
  for (let i = 0; i < n; i++) T[i] = sim.temp(i);
  postMessage({ type: 'snap', t: sim.t, x, T, steps: sim.steps }, [x.buffer, T.buffer]);
}
function loop() {
  if (stopped) return;
  const t0 = performance.now();
  while (performance.now() - t0 < 120 && sim.t < tMax) {
    sim.step();
    if (sim.t >= nextSnap) { snap(); nextSnap = sim.t + snapEvery(sim.t); }
  }
  if (sim.t < tMax) setTimeout(loop, 0); else postMessage({ type: 'done', t: sim.t });
}
onmessage = (e) => {
  const m = e.data;
  if (m.cmd === 'stop') { stopped = true; return; }
  if (m.cmd === 'start') {
    const c = m.cfg; tMax = c.tMax;
    // each body relaxes on its own first (damped), so it starts near hydrostatic balance
    const T = SPH.sphere(c.m1, c.R1, c.n1, 0, 11), I = SPH.sphere(c.m2, c.R2, c.n2, 1, 7);
    postMessage({ type: 'status', text: 'settling the planets' });
    for (let k = 0; k < c.relax; k++) { T.step(0.1); I.step(0.1); }
    T.t = I.t = 0;
    sim = SPH.join([{ sp: T, x0: c.x1, v0: c.v1 }, { sp: I, x0: c.x2, v0: c.v2 }]);
    sim.dt = 0;
    postMessage({ type: 'init', n: sim.n, mat: sim.mat.slice(), m: sim.m[0] });
    nextSnap = 0; loop();
  }
};
