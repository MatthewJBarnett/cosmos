// Loads the app and fails if any shader program does not compile or link. Run before pushing.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage(); await page.setViewport({ width: 320, height: 180 });
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
page.on('pageerror', e => errs.push(e.message));
await page.goto('http://localhost:8642/?test=1&tex=49&cube=32&galr=0.1&scale=0.5', { waitUntil: 'load' });
await page.waitForFunction('window.cosmos !== undefined', { timeout: 300000 });
const r = await page.evaluate(async () => { const m = await import(new URL('src/gl.js', location.href).href); return m.allPrograms.map(p => p.name + ':' + (p.broken ? 'BROKEN' : p.linked ? 'ok' : 'unlinked')); });
const bad = r.filter(x => !x.endsWith(':ok'));
console.log(r.length + ' programs, ' + bad.length + ' not ok' + (bad.length ? ': ' + bad.join(', ') : ''));
for (const e of errs) console.log('[error]', e);
await browser.close();
process.exit(bad.length || errs.length ? 1 : 0);
