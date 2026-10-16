// Entry point: boots WebGL, the world and the UI, and runs the frame loop.
import { initGL, gl, allPrograms } from './gl.js';
import { Renderer, rcfg } from './render.js';
import { Nav, findByName, solSystem, systemFor } from './nav.js';
import { cfg as planetCfg } from './planet.js';
import { skyCfg } from './sky.js';
import { atmoCfg } from './atmosphere.js';
import { UI } from './ui.js';
import { loading, loadCatalog } from './assets.js';
import { initPlanetPrograms } from './planet.js';
import { initAtmoPrograms } from './atmosphere.js';
import { initSkyPrograms } from './sky.js';
import { initExtraPrograms, initRingParticles } from './extras.js';
import { initExoticPrograms } from './exotic.js';
import { V, Q, C } from './math.js';

const params = new URLSearchParams(location.search);
function showLoading(msg) {
  let d = document.getElementById('loading');
  if (!d) { d = document.createElement('div'); d.id = 'loading'; document.body.appendChild(d); }
  d.innerHTML = '<div class="ld-title">COSMOS</div><div class="ld-msg">' + msg + '</div><div class="ld-bar"><div></div></div>';
}
function setLoading(frac) { const b = document.querySelector('#loading .ld-bar div'); if (b) b.style.width = (frac * 100).toFixed(0) + '%'; }
function hideLoading() { const d = document.getElementById('loading'); if (d) { d.classList.add('done'); setTimeout(() => d.remove(), 900); } }
const num = (k, d) => params.has(k) ? +params.get(k) : d;
const canvas = document.getElementById('gl');
let renderer, nav, ui;
try {
  initGL(canvas);
  const quality = params.get('q') || 'high';
  if (quality === 'low') { planetCfg.T = 97; atmoCfg.steps = 14; atmoCfg.cloudSteps = 14; skyCfg.cubeSize = 512; atmoCfg.cloudRes = 384; skyCfg.galSteps = 40; }
  else if (quality === 'medium') { planetCfg.T = 145; atmoCfg.steps = 20; atmoCfg.cloudSteps = 22; skyCfg.cubeSize = 768; atmoCfg.cloudRes = 512; }
  planetCfg.T = num('tex', planetCfg.T); if ((planetCfg.T - 1) % 3) planetCfg.T = 193;
  planetCfg.genPerFrame = num('gen', 3);
  skyCfg.cubeSize = num('cube', skyCfg.cubeSize); skyCfg.galRange = num('galr', 1);
  atmoCfg.cloudRes = num('cloudres', atmoCfg.cloudRes); atmoCfg.steps = num('asteps', atmoCfg.steps); atmoCfg.cloudSteps = num('csteps', atmoCfg.cloudSteps);
  rcfg.scale = num('scale', Math.min(window.devicePixelRatio || 1, 1.5)); rcfg.scaleMax = rcfg.scale; rcfg.autoScale = !params.has('scale') && !params.has('test'); rcfg.quality = quality;
  const L = (m) => { if (params.has('log')) console.log('LOG ' + m + ' ' + performance.now().toFixed(0)); }; window.__L = L;
  L('gl'); rcfg.prof = params.has('prof');
  // create every shader program now so the driver compiles them in parallel, instead of stalling mid-flight
  showLoading('Compiling shaders');
  initPlanetPrograms(); initAtmoPrograms(); initSkyPrograms(); initExtraPrograms(); initRingParticles(); initExoticPrograms();
  renderer = new Renderer(canvas); L('renderer');
  nav = new Nav(); L('nav');
  ui = new UI(nav, renderer, canvas);
} catch (e) {
  console.error(e);
  document.getElementById('ui').innerHTML = '<div class="fatal">Could not start: ' + e.message + '<br>This app needs WebGL2 with float render targets.</div>';
  throw e;
}

let last = performance.now(), fpsAcc = 0, fpsN = 0, slow = 0, fast = 0;
function frame(dt) {
  nav.update(dt, ui.input(dt)); if (window.__L) window.__L('nav.update');
  renderer.render(nav, dt); if (window.__L) { gl.finish(); window.__L('render'); }
  ui.update(dt);
}
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) {
    ui.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0;
    // dynamic resolution keeps the frame rate usable on slower GPUs
    if (rcfg.autoScale && now > 6000) {
      // aim for a steady 55+ fps; temporal AA hides most of the resolution loss
      if (ui.fps < 48) { slow++; fast = 0; } else if (ui.fps > 57) { fast++; slow = 0; } else { slow = 0; fast = 0; }
      if (slow >= 2 && rcfg.scale > 0.5) { rcfg.scale = Math.max(0.5, rcfg.scale * (ui.fps < 30 ? 0.8 : 0.9)); slow = 0; }
      if (fast >= 8 && rcfg.scale < rcfg.scaleMax) { rcfg.scale = Math.min(rcfg.scaleMax, rcfg.scale * 1.08); fast = 0; }
    }
  }
  try { frame(dt); } catch (e) { console.error(e); ui.fatal(e); return; }
  requestAnimationFrame(loop);
}
// optional start location and date: ?goto=Saturn&date=2017-06-01
if (params.has('date')) { const ds = params.get('date'); const d = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(ds) || ds.length <= 10 ? ds : ds + 'Z'); if (!isNaN(d)) nav.time = (d - Date.UTC(2000, 0, 1, 12)) / 1000; }
if (params.has('goto')) {
  const t = findByName(nav, params.get('goto'));
  if (t && params.has('land') && t.type === 'body') { const [la, lo] = params.get('land').split(',').map(Number); nav.landAt(t.body, la, lo, { dur: 0.01 }); }
  else if (t) { nav.selected = t; nav.goTo(t, { dur: 0.01 }); }
}
const testMode = params.has('test');
async function waitPrograms() {
  const t0 = performance.now();
  for (;;) {
    const n = allPrograms.filter(p => p.done).length;
    setLoading(n / allPrograms.length * 0.9);
    if (n === allPrograms.length || performance.now() - t0 > 60000) break;
    await new Promise(r => setTimeout(r, 30));
  }
  // a shader that fails on this GPU disables its feature instead of stopping the app
  for (const p of allPrograms) { try { p.finish(); } catch (e) { console.error(e); p.broken = true; } }
}
await waitPrograms();
loadCatalog();
// draw a few frames behind the loading screen so the first visible frame is complete
for (let i = 0; i < 3; i++) { try { frame(0.016); } catch (e) { console.error(e); } setLoading(0.9 + i * 0.03); await new Promise(r => setTimeout(r, 0)); }
hideLoading();
if (!testMode) requestAnimationFrame(loop);

// Scripting / test hooks
window.cosmos = {
  nav, renderer, rcfg, V, Q, C, findByName, solSystem, systemFor, ui,
  frame,
  // run frames until no textures are loading any more (maps of nearby bodies are requested by rendering)
  async waitAssets(maxSec = 60) {
    const t0 = performance.now();
    do { frame(0.02); await new Promise(r => setTimeout(r, 200)); } while ((loading.count > 0 || performance.now() - t0 < 600) && performance.now() - t0 < maxSec * 1000);
    frame(0.02); await new Promise(r => setTimeout(r, 100));
    return loading.count;
  },
  // run frames until all generation has finished and exposure has settled
  async settle(maxFrames = 400, dt = 0.05) {
    renderer.sync = true; nav.sync = true; const g = planetCfg.genPerFrame; planetCfg.genPerFrame = 40;
    let calm = 0, n = 0;
    for (; n < maxFrames && calm < 4; n++) {
      if (nav.pendingLand) { await this.waitAssets(); }
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
