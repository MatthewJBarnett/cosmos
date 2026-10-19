// Like jitter.mjs, but grabs the canvas right after each c.frame() (no frames from the app's own loop in between).
// Usage: SETUP='...' node jitter2.mjs outdir params frames
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const out = process.argv[2], extra = process.argv[3] || '', n = +(process.argv[4] || 12);
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 900000, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=960,540'] });
const page = await browser.newPage(); await page.setViewport({ width: 960, height: 540 });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto((process.env.BASE || 'http://localhost:8642/') + '?' + extra, { waitUntil: 'load' });
await page.waitForFunction('window.cosmos && document.getElementById("loading") === null', { timeout: 300000 });
await page.evaluate(async () => { const c = window.cosmos; c.ui.root.classList.add('hide'); c.nav.paused = true; for (let i = 0; i < 40; i++) { c.frame(1 / 30); await new Promise(r => setTimeout(r, 30)); if (i > 20 && !c.renderer.stats.pending && i % 10 === 0) { await c.waitAssets(); if (!c.renderer.stats.pending) break; } } });
await page.evaluate(async () => { window.__pl = await import('/src/planet.js'); });
if (process.env.SETUP) await page.evaluate((code) => { const c = window.cosmos; new Function('c', code)(c); }, process.env.SETUP);
// stop the app's own loop from rendering in between: grab inside the same task as the frame
for (let i = 0; i < n; i++) {
  const [url, ex] = await page.evaluate(() => { const c = window.cosmos; c.frame(1 / 30); const r = c.renderer; return [document.querySelector('canvas').toDataURL('image/png'), [Math.log2(r.exposure).toFixed(3), (r.lumHi || 0).toExponential(2), (r.lumTop || 0).toExponential(2), (r.lumAvgC || 0).toExponential(2), r.meterTop, r._compact, r.stats.pending, r.stats.drawn, (window.__pl && window.__pl.totalChunks ? window.__pl.totalChunks() : -1)]]; });
  fs.writeFileSync(`${out}/j${i}.png`, Buffer.from(url.split(',')[1], 'base64'));
  console.log('f' + i, JSON.stringify(ex));
}
console.log('frameNo', await page.evaluate(() => window.cosmos.renderer.frameNo));
await browser.close();
