// Time-lapse lock check: from Earth orbit and Earth's surface at fast rates, the Sun's direction as seen by the
// camera should hold still from frame to frame (no strobing). Usage: node tools/lapsetest.mjs
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 900000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=240,135'] });
const page = await browser.newPage(); await page.setViewport({ width: 240, height: 135 });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:8642/?test=1&tex=49&cube=64&cloudres=128&scale=0.5&galr=0.2', { waitUntil: 'load' });
await page.waitForFunction('window.cosmos !== undefined', { timeout: 120000 });
const r = await page.evaluate(async () => {
  const c = window.cosmos, nav = c.nav, V = c.V, Q = c.Q, out = [];
  const tl = c.ui.timeline;
  for (const [name, setup] of [['orbit', () => tl.go(tl.events.find(e => e.id === 'iceage'))], ['surface', () => { const e = c.solSystem().find('Earth'); nav.landAt(e, 40, -100, { hour: 15 }); }]]) {
    setup(); for (let i = 0; i < 400 && (nav.goto || nav.pendingLand); i++) { c.frame(0.05); if (i % 10 === 0) await new Promise(r => setTimeout(r, 0)); }
    for (const rate of [3600 * 24, 3e6, c.YEAR * 1, c.YEAR * 1e4, c.YEAR * 1e6]) {
      nav.paused = false; nav.rate = rate; const sun = c.solSystem().find('Sun'); let maxD = 0, prev = null, t0 = nav.time, lockD = 0, lockY = 0;
      for (let i = 0; i < 30; i++) { c.frame(1 / 60); const d = Q.rot(Q.conj(nav.q), V.norm(V.sub(sun.wpos, nav.S))); if (prev) maxD = Math.max(maxD, Math.acos(Math.min(1, V.dot(d, prev))) * 180 / Math.PI); prev = d; lockD += nav.dayLocked; lockY += nav.yearLocked; }
      out.push(`${name} rate ${(rate / c.YEAR).toExponential(1)} yr/s: sun moves up to ${maxD.toFixed(2)} deg/frame, day lock ${lockD}/30, orbit lock ${lockY}/30, advanced ${((nav.time - t0) / c.YEAR).toExponential(2)} yr, alt ${(nav.altitude / 1e3).toFixed(0)} km`);
    }
    nav.rate = 1; nav.paused = true;
  }
  return out;
});
console.log(r.join('\n'));
await browser.close();
