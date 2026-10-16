import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 1800000, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage(); await page.setViewport({ width: 400, height: 240 });
const errs = []; page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); }); page.on('pageerror', e => errs.push(e.message));
await page.goto('http://localhost:8642/?bench&q=low&scale=0.3&tex=49&galr=0.1', { waitUntil: 'load' });
await page.waitForFunction('document.querySelector(".bench pre") !== null', { timeout: 1700000, polling: 5000 }).catch(e => errs.push('timeout ' + e.message));
const t = await page.evaluate(() => document.querySelector('.bench pre') ? document.querySelector('.bench pre').textContent : 'none');
console.log(t); console.log('errors', errs.length, errs.slice(0, 3).join(' | '));
await browser.close();
