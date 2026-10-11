// Runs the app in normal (non-test) mode for a few seconds and reports console errors.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=640,360'] });
const page = await browser.newPage(); await page.setViewport({ width: 640, height: 360 });
let errors = 0;
page.on('console', m => { if (m.type() === 'error') { console.log('[error]', m.text().slice(0, 800)); errors++; } });
page.on('pageerror', e => { console.log('[pageerror]', e.message); errors++; });
await page.goto('http://localhost:8642/?tex=49&cube=64&cloudres=128&galr=0.2&asteps=8&csteps=8&scale=0.5', { waitUntil: 'load' });
await new Promise(r => setTimeout(r, 12000));
await page.mouse.move(320, 180); await page.mouse.down(); await page.mouse.move(360, 200, { steps: 4 }); await page.mouse.up();
await page.mouse.wheel({ deltaY: -200 });
await page.keyboard.down('w'); await new Promise(r => setTimeout(r, 3000)); await page.keyboard.up('w');
await page.keyboard.press('Tab'); await page.keyboard.press('h'); await page.keyboard.press('h'); await page.keyboard.press('6'); await new Promise(r => setTimeout(r, 6000)); await page.keyboard.press('c'); await page.keyboard.press('l');
await page.mouse.click(100, 300);
await new Promise(r => setTimeout(r, 4000));
const st = await page.evaluate(() => JSON.stringify({ fps: cosmos.ui.fps, stats: cosmos.renderer.stats, level: cosmos.nav.level, sel: cosmos.nav.selected && cosmos.nav.selected.type }));
console.log('live', st, 'errors', errors);
await page.screenshot({ path: new URL('../shots/live.png', import.meta.url).pathname });
await browser.close();
