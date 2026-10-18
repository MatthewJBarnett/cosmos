// Frame-to-frame flicker test: a static, paused view rendered many times; reports per-pixel temporal variation.
// Usage: node flicker.mjs outdir [url params]
import puppeteer from 'puppeteer-core';
const out = process.argv[2], extra = process.argv[3] || 'q=low';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 900000, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=390,700'] });
const page = await browser.newPage(); await page.setViewport({ width: 390, height: 700, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:8642/?' + extra, { waitUntil: 'load' });
await page.waitForFunction('window.cosmos && document.getElementById("loading") === null', { timeout: 300000 });
console.log('settle', await page.evaluate(async () => { const c = window.cosmos; c.ui.root.classList.add('hide'); c.nav.paused = true; let i = 0; for (; i < 400; i++) { c.frame(1 / 15); await new Promise(r => setTimeout(r, 40)); if (i > 60 && !c.renderer.stats.pending && i % 10 === 0) { await c.waitAssets(); if (!c.renderer.stats.pending) break; } } return i; }));
if (process.env.NOCOMPACT) await page.evaluate(() => { window.cosmos.rcfg.compactMeter = false; });
const ex = [];
for (let i = 0; i < 8; i++) {
  ex.push(await page.evaluate(async () => { const c = window.cosmos; c.frame(1 / 15); await new Promise(r => setTimeout(r, 30)); const e = c.nav.system && c.nav.system.find('Earth'); const ag = await import('/src/atmo_glsl.js'); return Math.log2(c.renderer.exposure).toFixed(3) + '/t' + c.nav.time.toFixed(1) + '/wx' + ag.weatherUniform(e, c.nav.time).map(x => x.toFixed(3)).join(',') + '/st' + (e && e.maps && e.maps._state ? (e.maps._state.preview ? 'P' : 'F') + e.mapsVersion : '-'); }));
  await page.screenshot({ path: `${out}/f${i}.png` });
}
console.log(ex.join('\n'));
await browser.close();
