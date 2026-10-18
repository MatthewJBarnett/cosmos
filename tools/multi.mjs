// Several scenes in one page (faster than one browser per shot): node multi.mjs scenes.json (EXTRA=&param adds URL params)
// several scenes in one page: node _multi.mjs scenes.json
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const scenes = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=960,540'], protocolTimeout: 900000 });
const page = await browser.newPage(); await page.setViewport({ width: 960, height: 540 });
let errors = 0;
page.on('console', m => { if (m.type() === 'error') { errors++; console.log('[error]', m.text().slice(0, 300)); } });
page.on('pageerror', e => { errors++; console.log('[pageerror]', e.message); });
await page.goto('http://localhost:8642/?test=1' + (process.env.EXTRA || '') + '&tex=97&cube=256&cloudres=384&scale=1&galr=0.4', { waitUntil: 'load' });
await page.waitForFunction('window.cosmos !== undefined', { timeout: 120000 });
for (const sc of scenes) {
  const t0 = Date.now();
  const r = await page.evaluate(async (code) => { const c = window.cosmos, nav = c.nav; const f = new Function('c', 'nav', 'V', 'Q', 'C', 'return (async () => {' + code + '})()'); try { return JSON.stringify(await f(c, nav, c.V, c.Q, c.C)); } catch (e) { return 'ERR ' + e.message; } }, sc.code);
  await page.screenshot({ path: `../shots/${sc.name}.png` });
  console.log(sc.name, (r || '').slice(0, 600), ((Date.now() - t0) / 1000).toFixed(0) + 's');
}
console.log(errors + ' errors');
await browser.close();
