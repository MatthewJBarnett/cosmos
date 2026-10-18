// Render the Milky Way (or another event view) in each observing band: node bands.mjs [event] [bands, e.g. 0,2,5]
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=640,360'], protocolTimeout: 900000 });
const page = await browser.newPage(); await page.setViewport({ width: 640, height: 360 });
page.on('pageerror', e => console.log('PAGEERROR', e.message)); page.on('console', m => { if (m.type() === 'error') console.log('ERR', m.text().slice(0, 200)); });
await page.goto('http://localhost:8642/?test=1&tex=49&cube=128&galr=0.3&scale=1', { waitUntil: 'load' });
await page.waitForFunction('window.cosmos !== undefined', { timeout: 120000 });
const scene = process.argv[2] || 'galyear';
await page.evaluate(async (scene) => { const c = window.cosmos; c.ui.root.classList.add('hide'); const tl = c.ui.timeline; tl.go(tl.events.find(e => e.id === scene)); await c.settle(10); c.nav.rate = 0; c.nav.paused = true; c.nav.selected = null; }, scene);
for (const b of (process.argv[3] || "0,1,2,3,4,5,6").split(",").map(Number)) {
  await page.evaluate(async (b) => { const c = window.cosmos; c.ui.setBand(b); for (let i = 0; i < 30; i++) c.frame(0.05); await c.settle(20); }, b);
  await page.screenshot({ path: `../shots/band_${scene}_${b}.png` });
}
await browser.close();
