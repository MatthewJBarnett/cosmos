// Visit a set of timeline events / sandbox scenarios with every draw call checked for GL errors.
// Usage: node glcheck.mjs [event ids...]  (default: a representative set)
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['betelgeuse', 'rgb', 'pn', 'm31', 'merge', 'galyear', 'horizon', 'phobos', 'eclipses'];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 1800000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=320,180'] });
const page = await browser.newPage(); await page.setViewport({ width: 320, height: 180 });
let errs = 0;
page.on('console', m => { const t = m.text(); if (t.startsWith('GLERR') || m.type() === 'error') { errs++; console.log(t.slice(0, 400)); } if (t.startsWith('STEP')) console.log(t); });
page.on('pageerror', e => { errs++; console.log('PAGEERROR', e.message); });
await page.goto('http://localhost:8642/?test=1&tex=49&cube=128&cloudres=256&scale=1&galr=0.2', { waitUntil: 'load' });
await page.waitForFunction('window.cosmos !== undefined', { timeout: 120000 });
const hook = fs.readFileSync(new URL('./glhook.js', import.meta.url), 'utf8');
await page.evaluate(new Function('return (async () => {' + hook + '})()'));
const run = (code) => page.evaluate(async (code) => { const c = window.cosmos, nav = c.nav; await new Function('c', 'nav', 'return (async () => {' + code + '})()')(c, nav);
  for (let i = 0; i < 400 && (nav.goto || nav.pendingLand); i++) { c.frame(0.05); if (i % 10 === 0) await new Promise(r => setTimeout(r, 0)); }
  for (let i = 0; i < 20; i++) { c.frame(0.05); if (i % 5 === 0) await new Promise(r => setTimeout(r, 0)); } }, code);
await run('for (let i = 0; i < 20; i++) c.frame(0.05);'); console.log('STEP start');
for (const id of ids) { await run(`const tl = c.ui.timeline; tl.go(tl.events.find(e => e.id === '${id}'));`); console.log('STEP ' + id); }
for (const id of ['gw150914', 'tde', 'gw170817']) { await run(`const u = c.ui.sbui; u.start(u.presets.findIndex(p => p.id === '${id}')); nav.paused = false; for (let i = 0; i < 60; i++) c.frame(0.05);`); console.log('STEP sb ' + id); }
console.log(errs + ' GL/console errors');
await browser.close();
