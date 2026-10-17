// Randomised robustness test: random destinations, time rates, keys, clicks and drags in normal (non-test) mode.
import puppeteer from 'puppeteer-core';
const steps = +(process.argv[2] || 40), seed = +(process.argv[3] || 1);
let s = seed; const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 600000, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage(); await page.setViewport({ width: 480, height: 300 });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
await page.goto('http://localhost:8642/?q=low&tex=49&cube=32&galr=0.1&scale=0.4', { waitUntil: 'load' });
await page.waitForFunction('window.cosmos && document.getElementById("loading") === null', { timeout: 300000 }).catch(() => errors.push('never finished loading'));
const places = ['Earth', 'Moon', 'Mars', 'Jupiter', 'Saturn', 'Titan', 'Sun', 'Venus', 'Pluto', 'Sirius', 'TRAPPIST-1', 'Orion Nebula', 'Andromeda', 'Sagittarius A*', 'Crab Pulsar', "Halley's Comet", 'Europa', 'Vesta', 'Proxima Centauri', 'Milky Way'];
const keys = ['w', 's', 'a', 'd', 'q', 'e', 'r', 'f', 'g', 'l', 'y', '.', ',', 'j', ' ', '\\', 'k', 'o', 'n', 't', 'c', 'b', '1', '4', '6', 'z', 'x', '[', ']', 'Tab', 'h', 'u', 'v', '.', '.', '.'];
for (let i = 0; i < steps; i++) {
  const r = rnd();
  try {
    if (r < 0.3) { const p = places[Math.floor(rnd() * places.length)]; await page.evaluate((p) => { const t = cosmos.findByName(cosmos.nav, p); if (t) { cosmos.nav.selected = t; cosmos.nav.goTo(t, { dur: 0.5 }); } }, p); }
    else if (r < 0.4) await page.evaluate(() => { const n = cosmos.nav; if (n.selected && n.selected.type === 'body') n.land(n.selected.body, { dur: 0.5 }); });
    else if (r < 0.45) await page.evaluate((k) => cosmos.ui.explore(k), ['star', 'earthlike', 'rings', 'giant-star', 'galaxy'][Math.floor(rnd() * 5)]);
    else if (r < 0.5) {
      // deep time and physics: timeline events, sandbox scenarios, extreme rates
      const k = Math.floor(rnd() * 4), x = rnd();
      await page.evaluate((k, x) => { const u = cosmos.ui, tl = u.timeline;
        if (k === 0) tl.go(tl.events[Math.floor(x * tl.events.length)]);
        else if (k === 1) { u.sbui.start(Math.floor(x * 10) % 11); }
        else if (k === 2) { cosmos.nav.rate = cosmos.YEAR * Math.pow(10, Math.floor(x * 11)); cosmos.nav.paused = false; }
        else { cosmos.nav.rate = -Math.abs(cosmos.nav.rate); } }, k, x);
    }
    else if (r < 0.8) { const k = keys[Math.floor(rnd() * keys.length)]; await page.keyboard.down(k); await new Promise(r => setTimeout(r, 300)); await page.keyboard.up(k); }
    else if (r < 0.9) { await page.mouse.move(240, 150); await page.mouse.down(); await page.mouse.move(240 + (rnd() - 0.5) * 200, 150 + (rnd() - 0.5) * 150, { steps: 3 }); await page.mouse.up(); }
    else await page.mouse.click(Math.floor(rnd() * 480), Math.floor(rnd() * 300), { clickCount: rnd() < 0.5 ? 1 : 2 });
  } catch (e) { errors.push('STEP ' + i + ' ' + e.message.slice(0, 200)); }
  await new Promise(r => setTimeout(r, 1500));
}
const st = await page.evaluate(() => JSON.stringify({ level: cosmos.nav.level, sys: cosmos.nav.system && cosmos.nav.system.name, exp: cosmos.renderer.exposure, t: cosmos.nav.time, fps: cosmos.ui.fps })).catch(e => 'eval failed ' + e.message);
console.log('monkey seed', seed, 'steps', steps, st);
console.log(errors.length + ' errors'); for (const e of [...new Set(errors)].slice(0, 20)) console.log(' ', e);
await browser.close();
