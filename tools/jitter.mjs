// Frame-to-frame position jitter of the default view (Earth at startup, real time running): screenshots N frames and
// writes the frames and camera state; analyse with tools/jitter.py.
// Usage: node jitter.mjs outdir [url params] [frames]
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const out = process.argv[2], extra = process.argv[3] || '', n = +(process.argv[4] || 10);
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 900000, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=960,540'] });
const page = await browser.newPage(); await page.setViewport({ width: 960, height: 540 });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto((process.env.BASE || 'http://localhost:8642/') + '?' + extra, { waitUntil: 'load' });
await page.waitForFunction('window.cosmos && document.getElementById("loading") === null', { timeout: 300000 });
// let it settle as a user would see it (real time running), assets loaded
await page.evaluate(async () => { const c = window.cosmos; c.ui.root.classList.add('hide'); for (let i = 0; i < 60; i++) { c.frame(1 / 30); await new Promise(r => setTimeout(r, 30)); if (i > 20 && !c.renderer.stats.pending && i % 10 === 0) { await c.waitAssets(); if (!c.renderer.stats.pending) break; } } });
// (SETUP: code run once after settling, e.g. 'c.nav.paused = true' or 'c.rcfg.taa = false')
if (process.env.SETUP) await page.evaluate((code) => { const c = window.cosmos; new Function('c', code)(c); }, process.env.SETUP);
const rows = [];
for (let i = 0; i < n; i++) {
  const info = await page.evaluate(async () => { const c = window.cosmos; c.frame(1 / 30); await new Promise(r => setTimeout(r, 20)); const e = c.nav.anchor || (c.nav.selected && c.nav.selected.body); return { t: c.nav.time.toFixed(3), S: c.nav.S.map(x => x.toFixed(1)).join(','), anchor: e ? e.name : '-', exp: Math.log2(c.renderer.exposure).toFixed(3) }; });
  await page.screenshot({ path: `${out}/j${i}.png` });
  rows.push(`f${i} ${JSON.stringify(info)}`);
}
console.log(rows.join('\n'));
await browser.close();
