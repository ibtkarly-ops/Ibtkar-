// First-run experience in a real browser: brand-new store, no env credentials.
// Splash shows the real logo → /admin offers the setup form → owner creates the account → checklist → first product
// appears on the storefront. Also: opening the files without the server shows a clear diagnostic, not a broken shop.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'tests', 'shots'); fs.mkdirSync(shots, { recursive: true });
const PORT = 3993; const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abk-first-'));
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, NODE_ENV: 'development', SITE_URL: BASE };
delete env.ADMIN_EMAIL; delete env.ADMIN_PASSWORD;
const server = spawn('node', ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 150)); }

const browser = await chromium.launch(); const results = []; const errors = [];
const step = async (name, fn) => { try { await fn(); results.push([true, name]); console.log('  ✓', name); } catch (e) { results.push([false, name, e.message.split('\n')[0]]); console.log('  ✗', name, '\n     ', e.message.split('\n')[0]); } };
const shot = (p, n) => p.screenshot({ path: path.join(shots, `first-${n}.png`), fullPage: true });

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, locale: 'ar-LY' });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

console.log('\n▶ أول تشغيل');
await step('server announces the first-run setup in its log', async () => { if (!/إعداد أولي/.test(log) || !/رمز الإعداد/.test(log)) throw new Error('no setup hint in log: ' + log); });
await step('splash shows the real logo (cropped circle, burgundy background) then the home page', async () => {
  await page.goto(BASE + '/', { waitUntil: 'commit' });
  await page.waitForSelector('#splash .logo-disc img'); await page.waitForTimeout(500); await shot(page, 'splash');
  const src = await page.getAttribute('#splash .logo-disc img', 'src'); if (src !== '/assets/logo.webp') throw new Error('splash logo is ' + src);
  const circle = await page.evaluate(() => { const d = document.querySelector('#splash .logo-disc'); const s = getComputedStyle(d); const r = d.getBoundingClientRect(); return { radius: s.borderRadius, w: r.width, h: r.height, bg: getComputedStyle(document.querySelector('#splash')).backgroundImage.includes('rgb') }; });
  if (circle.radius !== '50%' || Math.abs(circle.w - circle.h) > 1) throw new Error('logo is not a circle ' + JSON.stringify(circle));
  await page.waitForSelector('#splash', { state: 'detached', timeout: 12000 });
  await page.waitForSelector('.hero, .slider'); await shot(page, 'home-empty');
  await page.waitForFunction(() => document.querySelector('[data-catalog]')?.innerText.includes('المتجر قيد التجهيز'));
});
await step('header and footer use the real logo; favicon is the logo', async () => {
  const n = await page.locator('.site-header .logo-disc img[src="/assets/logo.webp"]').count(); if (n !== 1) throw new Error('header logo ' + n);
  if ((await page.locator('footer .logo-disc img[src="/assets/logo.webp"]').count()) !== 1) throw new Error('footer logo');
  if (!/favicon-64\.png/.test(await page.getAttribute('link[rel=icon]', 'href'))) throw new Error('favicon');
});
await step('/admin shows the setup form (not a dead login) when no admin exists', async () => {
  await page.goto(BASE + '/admin'); await page.waitForSelector('#sf'); await shot(page, 'admin-setup');
  if (await page.locator('#sk').count()) throw new Error('code field shown on the same machine');
});
await step('owner creates the account → dashboard with the get-started checklist', async () => {
  await page.fill('#sn', 'مالك المتجر'); await page.fill('#se', 'owner@example.ly'); await page.fill('#sp', 'Owner-Strong-Pass-9'); await page.fill('#sc', 'different-1234');
  await page.click('#sf button[type=submit]'); await page.waitForSelector('.err'); await page.fill('#sc', 'Owner-Strong-Pass-9'); await page.click('#sf button[type=submit]');
  await page.waitForSelector('.stats'); await page.waitForSelector('text=ابدأ إعداد متجرك'); await shot(page, 'admin-dashboard-new');
  const side = await page.locator('.side-brand img[src="/assets/logo.webp"]').count(); if (side !== 1) throw new Error('admin sidebar logo');
});
await step('setup form is gone afterwards: /admin shows the normal login', async () => {
  const c2 = await browser.newContext({ locale: 'ar-LY' }); const p2 = await c2.newPage();
  await p2.goto(BASE + '/admin'); await p2.waitForSelector('#lf'); if (await p2.locator('#sf').count()) throw new Error('setup still open'); await c2.close();
});
await step('first product added from the admin appears on the storefront (database is connected)', async () => {
  await page.goto(BASE + '/admin/products'); await page.waitForSelector('#addp'); await page.click('#addp');
  await page.fill('.modal [name=name]', 'بكلاوه بالفستق'); await page.selectOption('.modal [name=category_id]', { label: 'بكلاوه' }); await page.fill('.modal [name=price]', '35');
  await page.click('.modal button[type=submit]'); await page.waitForSelector('tr:has-text("بكلاوه بالفستق")');
  await page.goto(BASE + '/'); await page.waitForSelector('[data-catalog] .card-name:has-text("بكلاوه بالفستق")'); await shot(page, 'home-with-product');
});
await step('opened as a plain file (no server): a clear explanation appears', async () => {
  const f = await browser.newContext({ locale: 'ar-LY' }); const p = await f.newPage();
  await p.goto('file://' + path.join(root, 'public', 'index.html'));
  await p.waitForSelector('#no-app h1', { state: 'visible', timeout: 9000 }); await shot(p, 'no-server-file');
  if (!/npm start/.test(await p.locator('#no-app').innerText())) throw new Error('no instructions'); await f.close();
});
await step('uploaded to STATIC hosting (public/ only): storefront and admin explain that the server is missing', async () => {
  const http = await import('node:http'); const fsp = await import('node:fs/promises');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/json' };
  const st = http.createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    try { const f = path.join(root, 'public', p); const b = await fsp.readFile(f); res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); res.end(b); }
    catch { try { const b = await fsp.readFile(path.join(root, 'public', 'index.html')); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); } catch { res.writeHead(404); res.end(); } }
  }).listen(0, '127.0.0.1'); await new Promise((r) => st.on('listening', r));
  const sb = `http://127.0.0.1:${st.address().port}`;
  const f = await browser.newContext({ locale: 'ar-LY' }); const p = await f.newPage();
  await p.goto(sb + '/'); await p.waitForSelector('h1:has-text("الخادم غير متصل")'); await shot(p, 'no-server-static');
  if (await p.locator('.card').count()) throw new Error('rendered a shop without a server');
  await p.goto(sb + '/admin/'); await p.waitForSelector('h1:has-text("الخادم غير متصل")');
  await f.close(); st.close();
});
await step('no JavaScript errors', async () => { const real = errors.filter((e) => !/file:\/\//.test(e) && !/CORS|Cross-Origin|origin 'null'|api\/(bootstrap|auth)|Unexpected token|JSON/i.test(e)); if (real.length) throw new Error(real.slice(0, 3).join(' | ')); });

await browser.close(); server.kill(); fs.rmSync(dataDir, { recursive: true, force: true });
const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
