// Steps through every tour stop (fast-forwarding travel) and reports errors; saves a frame per stop.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 1200000, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage(); await page.setViewport({ width: 640, height: 360 });
let errors = 0;
page.on('console', m => { if (m.type() === 'error') { console.log('[error]', m.text().slice(0, 400)); errors++; } });
page.on('pageerror', e => { console.log('[pageerror]', e.message); errors++; });
await page.goto('http://localhost:8642/?test=1&tex=49&cube=64&cloudres=128&galr=0.2&asteps=8&csteps=8&scale=1', { waitUntil: 'load' });
await page.waitForFunction('window.cosmos !== undefined', { timeout: 120000 });
const n = await page.evaluate(() => import('/src/tour.js').then(m => m.STOPS.length));
for (let i = 0; i < n; i++) {
  await page.evaluate(() => { cosmos.ui.hidden = true; cosmos.ui.root.classList.add('hide'); }); const r = await page.evaluate(async (i) => {
    const c = window.cosmos, ui = c.ui;
    if (i === 0) ui.tour.start(); else ui.tour.next();
    for (let k = 0; k < 400 && (c.nav.goto || c.nav.pendingLand); k++) { c.frame(0.25); if (k % 10 === 0) await new Promise(r => setTimeout(r, 0)); }
    if (c.nav.pendingLand) await c.waitAssets();
    await c.settle(25);
    return ui.tour.i + ' ' + (ui.capEl ? ui.capEl.querySelector('.ct').textContent : '') + ' | level ' + c.nav.level + ' | ' + (c.nav.system ? c.nav.system.name : '') + ' | alt ' + c.nav.altitude.toExponential(2);
  }, i);
  console.log(r);
  await page.screenshot({ path: new URL(`../shots/tour_${String(i).padStart(2, '0')}.png`, import.meta.url).pathname });
}
console.log('errors', errors);
await browser.close();
