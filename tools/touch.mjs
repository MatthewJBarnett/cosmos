// Loads the app with touch emulation and reports console errors.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage(); await page.setViewport({ width: 420, height: 800, hasTouch: true, isMobile: true });
let errors = 0;
page.on('console', m => { if (m.type() === 'error') { console.log('[error]', m.text().slice(0, 600)); errors++; } });
page.on('pageerror', e => { console.log('[pageerror]', e.message); errors++; });
await page.goto('http://localhost:8642/?test=1&tex=49&cube=64&cloudres=128&galr=0.2&asteps=8&csteps=8&scale=1', { waitUntil: 'load' });
await page.waitForFunction('window.cosmos !== undefined', { timeout: 60000 });
const r = await page.evaluate(async () => { const c = window.cosmos; await c.settle(60); const b = document.querySelector('.pad button'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); const p0 = c.nav.S.slice(); c.nav.speed = 1e6; for (let i = 0; i < 5; i++) c.frame(0.1); b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); return { pad: !!b, moved: Math.hypot(c.nav.S[0] - p0[0], c.nav.S[1] - p0[1], c.nav.S[2] - p0[2]) > 1 }; });
console.log('touch', JSON.stringify(r), 'errors', errors);
await page.screenshot({ path: new URL('../shots/touch.png', import.meta.url).pathname });
await browser.close();
