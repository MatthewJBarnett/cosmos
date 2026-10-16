// Benchmark: visits representative scenes, measures frame rate and GPU time per pass, shows a copyable report.
import { V, Q } from './math.js';
import { findByName } from './nav.js';
import { rcfg } from './render.js';

const iso = (s) => (Date.parse(s) - Date.UTC(2000, 0, 1, 12)) / 1000;
const SCENES = [
  { name: 'Earth from orbit', set: (nav) => { nav.time = iso('2024-06-20T12:00:00Z'); nav.goTo(findByName(nav, 'Earth'), { dur: 0.01 }); } },
  { name: 'Alps, ground', set: (nav) => { nav.landAt(findByName(nav, 'Earth').body, 46.0, 7.6, { dur: 0.01, hour: 15 }); } },
  { name: 'Forest, 60 m', set: (nav) => { nav.landAt(findByName(nav, 'Earth').body, 48.3, 8.2, { dur: 0.01, hour: 15 }); } },
  { name: 'Ocean, sunset', set: (nav) => { nav.landAt(findByName(nav, 'Earth').body, 20, -40, { dur: 0.01, hour: 18.2 }); } },
  { name: 'Saturn', set: (nav) => { nav.time = iso('2017-06-01T00:00:00Z'); nav.goTo(findByName(nav, 'Saturn'), { dur: 0.01 }); } },
  { name: 'Milky Way sky', set: (nav) => { nav.goTo(findByName(nav, 'Orion Nebula'), { dur: 0.01 }); } },
  { name: 'Andromeda', set: (nav) => { nav.goTo(findByName(nav, 'Andromeda'), { dur: 0.01 }); } },
];

export async function runBenchmark(cosmos) {
  const { nav, renderer, ui } = cosmos;
  const results = [], wasAuto = rcfg.autoScale; rcfg.autoScale = false; rcfg.gpuTimes = true;
  const panel = document.createElement('div'); panel.className = 'panel bench'; document.getElementById('ui').appendChild(panel);
  const show = (html) => { panel.innerHTML = html; };
  const frames = (n) => new Promise(res => { let k = 0; const f = () => { if (++k >= n) res(); else requestAnimationFrame(f); }; requestAnimationFrame(f); });
  for (const sc of SCENES) {
    show(`<h3>Benchmark</h3><div>${sc.name}: loading…</div>`);
    nav.paused = true; sc.set(nav);
    // wait for travel, maps and tile baking to finish
    const t0 = performance.now();
    while ((nav.goto || nav.pendingLand || renderer.stats.pending > 0) && performance.now() - t0 < 60000) await frames(10);
    await frames(60);
    if (renderer.gpuTimer) renderer.gpuTimer.results = {};
    const n = 180, s = performance.now(); await frames(n); const dt = (performance.now() - s) / n;
    const gpu = renderer.gpuTimer && renderer.gpuTimer.ok ? Object.entries(renderer.gpuTimer.results).filter(([k]) => k !== 'end').map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ') : 'n/a';
    const tot = renderer.gpuTimer && renderer.gpuTimer.ok ? Object.entries(renderer.gpuTimer.results).filter(([k]) => k !== 'end').reduce((a, [, v]) => a + v, 0) : 0;
    results.push({ scene: sc.name, fps: 1000 / dt, gpu: tot, detail: gpu, scale: rcfg.scale });
    show(`<h3>Benchmark</h3>` + results.map(r => `<div>${r.scene}: <b>${r.fps.toFixed(0)} fps</b>${r.gpu ? ' · GPU ' + r.gpu.toFixed(1) + ' ms' : ''}</div>`).join(''));
  }
  rcfg.autoScale = wasAuto;
  const gl = renderer.canvas.getContext('webgl2'), dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
  const text = `Cosmos benchmark\n${navigator.userAgent}\nGPU: ${gpuName}\nCanvas ${renderer.w}x${renderer.h}, render scale ${rcfg.scale}, quality ${rcfg.quality}\n` +
    results.map(r => `${r.scene}: ${r.fps.toFixed(1)} fps, GPU ${r.gpu.toFixed(1)} ms [${r.detail}]`).join('\n');
  show(`<h3>Benchmark done</h3><pre>${text.replace(/</g, '&lt;')}</pre><button id="bCopy">Copy report</button> <button id="bClose">Close</button>`);
  panel.querySelector('#bCopy').onclick = () => { (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => ui.toast('Report copied'), () => prompt('Benchmark report', text)); };
  panel.querySelector('#bClose').onclick = () => panel.remove();
  return text;
}
