// Loads the app with default (high) settings and reports console errors once frames are flowing.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 400000, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=480,270'] });
const page = await browser.newPage(); await page.setViewport({ width: 480, height: 270 });
let errors = 0;
page.on('console', m => { if (m.type() === 'error') { console.log('[error]', m.text().slice(0, 600)); errors++; } });
page.on('pageerror', e => { console.log('[pageerror]', e.message); errors++; });
await page.goto('http://localhost:8642/?scale=0.5', { waitUntil: 'load' });
await page.waitForFunction('window.cosmos && window.cosmos.renderer.frameNo > 6', { timeout: 300000, polling: 2000 }).catch(e => { console.log('timeout waiting for frames'); errors++; });
const st = await page.evaluate(() => JSON.stringify({ frames: cosmos.renderer.frameNo, stats: cosmos.renderer.stats, q: cosmos.rcfg.quality }));
console.log('defaults', st, 'errors', errors);
await browser.close();
