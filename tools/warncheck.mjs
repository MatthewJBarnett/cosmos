// Normal-mode session through the start view, an ice-age event and the Theia scenario; prints every distinct warning.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=480,270'] });
const page = await browser.newPage(); await page.setViewport({ width: 480, height: 270 });
const w = new Map();
page.on('console', m => { if (m.type() === 'warn' || m.type() === 'warning' || m.type() === 'error') { const k = m.text().slice(0, 160); w.set(k, (w.get(k) || 0) + 1); } });
await page.goto('http://localhost:8642/?tex=49&cube=64&cloudres=128&galr=0.2&scale=0.5', { waitUntil: 'load' });
await new Promise(r => setTimeout(r, 40000));
await page.evaluate(() => { const tl = cosmos.ui.timeline; tl.go(tl.events.find(e => e.id === 'iceage')); });
await new Promise(r => setTimeout(r, 30000));
await page.evaluate(() => { cosmos.ui.sbui.start(cosmos.ui.sbui.presets.findIndex(p => p.id === 'theia')); });
await new Promise(r => setTimeout(r, 30000));
for (const [k, n] of w) console.log(n + 'x ' + k);
console.log('done');
await browser.close();
