// Entry point: boots WebGL, the world and the UI, and runs the frame loop.
import { initGL, gl } from './gl.js';
import { Renderer, rcfg } from './render.js';
import { Nav, findByName, solSystem } from './nav.js';
import { cfg as planetCfg } from './planet.js';
import { skyCfg } from './sky.js';
import { atmoCfg } from './atmosphere.js';
import { UI } from './ui.js';
import { V, Q, C } from './math.js';

const params = new URLSearchParams(location.search);
const num = (k, d) => params.has(k) ? +params.get(k) : d;
const canvas = document.getElementById('gl');
let renderer, nav, ui;
try {
  initGL(canvas);
  planetCfg.T = num('tex', 193); if ((planetCfg.T - 1) % 3) planetCfg.T = 193;
  planetCfg.genPerFrame = num('gen', 3);
  skyCfg.cubeSize = num('cube', 1024); skyCfg.galRange = num('galr', 1);
  atmoCfg.cloudRes = num('cloudres', 768); atmoCfg.steps = num('asteps', 28); atmoCfg.cloudSteps = num('csteps', 32);
  rcfg.scale = num('scale', Math.min(window.devicePixelRatio || 1, 1.5));
  const L = (m) => { if (params.has('log')) console.log('LOG ' + m + ' ' + performance.now().toFixed(0)); }; window.__L = L;
  L('gl'); rcfg.prof = params.has('prof'); renderer = new Renderer(canvas); L('renderer');
  nav = new Nav(); L('nav');
  ui = new UI(nav, renderer, canvas);
} catch (e) {
  console.error(e);
  document.getElementById('ui').innerHTML = '<div class="fatal">Could not start: ' + e.message + '<br>This app needs WebGL2 with float render targets.</div>';
  throw e;
}

let last = performance.now(), fpsAcc = 0, fpsN = 0;
function frame(dt) {
  nav.update(dt, ui.input(dt)); if (window.__L) window.__L('nav.update');
  renderer.render(nav, dt); if (window.__L) { gl.finish(); window.__L('render'); }
  ui.update(dt);
}
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  fpsAcc += dt; fpsN++; if (fpsAcc > 0.5) { ui.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  try { frame(dt); } catch (e) { console.error(e); ui.fatal(e); return; }
  requestAnimationFrame(loop);
}
const testMode = params.has('test');
if (!testMode) requestAnimationFrame(loop);

// Scripting / test hooks
window.cosmos = {
  nav, renderer, rcfg, V, Q, C, findByName, solSystem, ui,
  frame,
  // run frames until all generation has finished and exposure has settled
  async settle(maxFrames = 400, dt = 0.05) {
    renderer.sync = true; nav.sync = true; const g = planetCfg.genPerFrame; planetCfg.genPerFrame = 40;
    let calm = 0, n = 0;
    for (; n < maxFrames && calm < 4; n++) {
      const e0 = renderer.exposure;
      frame(dt);
      const stable = Math.abs(Math.log(renderer.exposure / e0)) < 0.02;
      calm = (renderer.stats.pending === 0 && !nav.goto && stable) ? calm + 1 : 0;
      if (params.has('log')) console.log('LOG frame ' + n + ' calm ' + calm + ' ' + JSON.stringify(renderer.stats) + ' goto ' + !!nav.goto + ' alt ' + nav.altitude.toFixed(1));
      if (n % 5 === 4) await new Promise(r => setTimeout(r, 0));
    }
    gl.finish();
    renderer.sync = false; nav.sync = false; planetCfg.genPerFrame = g;
    return n;
  },
};
