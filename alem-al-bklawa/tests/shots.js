// Visual smoke test: opens pages on mobile + desktop, reports JS errors, saves screenshots to tests/shots/.
// usage: BASE=http://localhost:3112 node tests/shots.js [path ...]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3112';
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(out, { recursive: true });
const pages = process.argv.slice(2).length ? process.argv.slice(2) : ['/', '/shop', '/bundles', '/branches', '/about', '/product/1', '/bundle/1', '/login', '/register', '/forgot', '/track', '/privacy'];
const browser = await chromium.launch();
let bad = 0;
for (const [name, vp, mobile] of [['m', { width: 390, height: 844 }, true], ['d', { width: 1366, height: 900 }, false]]) {
  const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, deviceScaleFactor: 1, locale: 'ar-LY' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url()));
  for (const p of pages) {
    errors.length = 0;
    await page.goto(BASE + p, { waitUntil: 'networkidle' });
    await page.waitForTimeout(p === pages[0] ? 2200 : 600);
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 70)); } window.scrollTo(0, 0); });
    await page.waitForTimeout(500);
    const file = path.join(out, `${name}${p.replace(/\W+/g, '_') || '_home'}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    if (errors.length || overflow) { bad++; console.log(`✗ [${name}] ${p}`, overflow ? '(horizontal overflow)' : '', errors.slice(0, 4)); } else console.log(`✓ [${name}] ${p}`);
  }
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
