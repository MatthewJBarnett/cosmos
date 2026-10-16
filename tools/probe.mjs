// Run code in the page, then log state every interval. Usage: node probe.mjs "<setup js>" [seconds] [w h]
import puppeteer from 'puppeteer-core';
const [code = '', secs = '30', w = '800', h = '450', extra = 'tex=97&cube=256&cloudres=384&scale=1&galr=0.2'] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--window-size=${w},${h}`], protocolTimeout: 900000 });
const page = await browser.newPage();
await page.setViewport({ width: +w, height: +h });
page.on('console', m => console.log('[' + m.type() + ']', m.text().slice(0, 600)));
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('error', e => console.log('[crash]', e.message));
await page.goto(`http://localhost:8642/?test=1&${extra}`, { waitUntil: 'load' });
await page.waitForFunction('window.cosmos !== undefined', { timeout: 60000 });
await page.evaluate(async (code) => { const c = window.cosmos, nav = c.nav; await new Function('c', 'nav', 'V', 'Q', 'C', 'return (async () => {' + code + '})()')(c, nav, c.V, c.Q, c.C);
  setInterval(() => { const r = c.renderer; console.log('LOG t=' + (nav.time / c.YEAR).toExponential(3) + ' lvl=' + nav.level + ' heap=' + (performance.memory.usedJSHeapSize / 1e6).toFixed(0) + 'MB stars=' + r.stats.stars + ' cells=' + (nav.field ? nav.field.cells.size : 0) + ' frame=' + r.frameNo); }, 1000); }, code);
await new Promise(r => setTimeout(r, +secs * 1000));
await browser.close();
