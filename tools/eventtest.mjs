// Visit every timeline event (and every sandbox scenario) in one page and screenshot each one.
// Usage: node eventtest.mjs [w h] -> shots/ev_<id>.png, prints level / brightness / errors per event
import puppeteer from 'puppeteer-core';
const [w = '480', h = '270'] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 1800000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--window-size=${w},${h}`] });
const page = await browser.newPage(); await page.setViewport({ width: +w, height: +h });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
await page.goto(`http://localhost:${process.env.PORT || 8642}/?test=1&tex=49&cube=128&cloudres=256&scale=1&galr=0.2`, { waitUntil: 'load' });
await page.waitForFunction('window.cosmos !== undefined', { timeout: 120000 });
const ids = await page.evaluate(() => cosmos.ui.timeline.events.map(e => e.id));
const sb = await page.evaluate(() => cosmos.ui.sbui.presets.map(p => p.id));
const out = (n) => new URL(`../shots/${n}.png`, import.meta.url).pathname;
async function shot(name, code) {
  const n0 = errors.length, t0 = Date.now();
  const r = await page.evaluate(async (code) => {
    const c = window.cosmos, nav = c.nav;
    await new Function('c', 'nav', 'return (async () => {' + code + '})()')(c, nav);
    for (let i = 0; i < 400 && (nav.goto || nav.pendingLand); i++) { c.frame(0.05); if (i % 10 === 0) await new Promise(r => setTimeout(r, 0)); }
    nav.paused = true;
    await c.settle(12);
    // mean brightness of the frame (0-255) from a small readback of the canvas
    const cv = document.querySelector('canvas'), tc = document.createElement('canvas'); tc.width = 32; tc.height = 18;
    const g = tc.getContext('2d'); g.drawImage(cv, 0, 0, 32, 18); const d = g.getImageData(0, 0, 32, 18).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return { level: nav.level, sys: nav.system ? nav.system.name : '', mean: +(s / (d.length / 4)).toFixed(1), sel: nav.selected ? (nav.selected.body ? nav.selected.body.name : nav.selected.type) : '' };
  }, code).catch(e => ({ err: e.message.slice(0, 200) }));
  await page.screenshot({ path: out(name) });
  console.log(name.padEnd(22), JSON.stringify(r), ((Date.now() - t0) / 1000).toFixed(0) + 's', errors.length > n0 ? 'ERRORS: ' + errors.slice(n0).join(' | ') : '');
}
for (const id of ids) await shot('ev_' + id, `const tl = c.ui.timeline; tl.go(tl.events.find(e => e.id === '${id}'));`);
for (const id of sb) await shot('sb_' + id, `const u = c.ui.sbui; u.start(u.presets.findIndex(p => p.id === '${id}')); for (let i = 0; i < 30; i++) c.frame(0.05);`);
console.log(errors.length + ' errors total');
await browser.close();
