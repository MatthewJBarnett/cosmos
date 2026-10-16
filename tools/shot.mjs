// Headless screenshot harness. Usage: node shot.mjs <name> "<js run in page before settling>" [w] [h] [urlparams]
import puppeteer from 'puppeteer-core';
const [name, code = '', w = '1280', h = '720', extra = 'tex=97&cube=256&cloudres=384&scale=1&galr=0.4'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', ...(process.env.GLARGS ? process.env.GLARGS.split(' ') : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']), '--ignore-gpu-blocklist', `--window-size=${w},${h}`],
  protocolTimeout: 900000,
});
const page = await browser.newPage();
await page.setViewport({ width: +w, height: +h });
let errors = 0;
page.on('console', m => { const t = m.text(); if (m.type() === 'error' || m.type() === 'warning' || t.startsWith('LOG')) { console.log('[' + m.type() + ']', t.slice(0, 1500)); if (m.type() === 'error') errors++; } });
page.on('pageerror', e => { console.log('[pageerror]', e.message); errors++; });
await page.goto(`http://localhost:8642/?test=1&${extra}`, { waitUntil: 'load' });
await page.waitForFunction('window.cosmos !== undefined', { timeout: 60000 }).catch(() => console.log('cosmos did not start'));
const t0 = Date.now();
const res = await page.evaluate(async (code) => {
  if (!window.cosmos) return 'no cosmos';
  const c = window.cosmos, nav = c.nav;
  const f = new Function('c', 'nav', 'V', 'Q', 'C', 'return (async () => {' + code + '})()');
  const r = await f(c, nav, c.V, c.Q, c.C);
  const n = await c.settle(300);
  return JSON.stringify({ r, frames: n, stats: c.renderer.stats, level: nav.level, alt: nav.altitude });
}, code).catch(e => 'ERR ' + e.message);
console.log(name, res, ((Date.now() - t0) / 1000).toFixed(1) + 's');
await page.screenshot({ path: new URL(`../shots/${name}.png`, import.meta.url).pathname });
await browser.close();
process.exit(errors ? 1 : 0);
