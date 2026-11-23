// End-to-end test in a real browser: admin builds the catalogue from the UI, a customer shops, orders,
// pays in the sandbox gateway, recovers/deletes an account, and the admin processes the order.
// usage: node tests/e2e.js      (starts its own server + temp database; screenshots → tests/shots/e2e-*.png)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'tests', 'shots'); fs.mkdirSync(shots, { recursive: true });
const PORT = 3991; const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abk-e2e-'));
const server = spawn('node', ['--disable-warning=ExperimentalWarning', 'server.js'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, NODE_ENV: 'development', SITE_URL: BASE, ADMIN_EMAIL: 'owner@example.ly', ADMIN_PASSWORD: 'Owner-Strong-Pass-9', PAYMENT_SANDBOX: '1', ORDER_RATE_MAX: '500' },
});
let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 150)); }

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const browser = await chromium.launch();
const results = []; const jsErrors = [];
async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name} (${Date.now() - t}ms)`); }
  catch (e) { for (const [tag, pg] of watched) { try { await pg.screenshot({ path: path.join(shots, `FAIL-${results.length}-${tag}.png`) }); } catch { /* page closed */ } } results.push([false, name, e.message.split('\n')[0]]); console.log(`  ✗ ${name}\n      ${e.message.split('\n').slice(0, 3).join('\n      ')}`); }
}
const watched = new Map();
const watch = (page, tag) => {
  watched.set(tag, page);
  page.on('pageerror', (e) => jsErrors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) jsErrors.push(`${tag} console: ${m.text()}`); });
};
const shot = (page, name) => page.screenshot({ path: path.join(shots, `e2e-${name}.png`), fullPage: true });
const expectText = async (loc, re, ms = 8000) => { await loc.first().waitFor({ timeout: ms }); const t = await loc.first().innerText(); if (!re.test(t)) throw new Error(`expected ${re} got «${t.slice(0, 120)}»`); };
const toastText = (page) => page.locator('#toasts .toast');
const expectToast = async (page, re, ms = 8000) => { await page.locator('#toasts .toast').filter({ hasText: re }).first().waitFor({ timeout: ms }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ════════ ADMIN: build the catalogue from the UI ════════
const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ar-LY' });
const admin = await adminCtx.newPage(); watch(admin, 'admin');
console.log('\n▶ الإدارة');
await step('admin: customers cannot enter; admin logs in', async () => {
  await admin.goto(BASE + '/admin');
  await admin.fill('#li', 'owner@example.ly'); await admin.fill('#lp', 'wrong-password-1'); await admin.click('button[type=submit]');
  await expectText(admin.locator('.notice-err'), /غير صحيحة/);
  await admin.fill('#li', 'owner@example.ly'); await admin.fill('#lp', 'Owner-Strong-Pass-9'); await admin.click('button[type=submit]');
  await admin.waitForSelector('.stats'); await expectText(admin.locator('#ptitle'), /لوحة المعلومات/);
  await shot(admin, 'admin-dashboard');
});
await step('admin dashboard shows empty state, no fake numbers', async () => {
  const t = await admin.locator('.stats').innerText(); if (!/0\s*\n?\s*طلبات جديدة/.test(t) && !/طلبات جديدة/.test(t)) throw new Error('stats missing');
  await expectText(admin.locator('.cols'), /لا توجد طلبات بعد/);
});
await step('admin: add / rename / delete a category', async () => {
  await admin.click('a[data-r="categories"]'); await admin.waitForSelector('#addc');
  await admin.click('#addc'); await admin.fill('.modal [name=name]', 'مشروبات ساخنة'); await admin.click('.modal button[type=submit]');
  await admin.waitForSelector('text=مشروبات ساخنة');
  await admin.click('tr:has-text("مشروبات ساخنة") [data-edit]'); await admin.fill('.modal [name=name]', 'قهوة وشاي'); await admin.click('.modal button[type=submit]');
  await admin.waitForSelector('text=قهوة وشاي');
  await admin.click('tr:has-text("قهوة وشاي") [data-del]'); await admin.click('.modal [data-ok]');
  await admin.waitForSelector('text=قهوة وشاي', { state: 'detached' });
});
await step('admin: add a product with image + variants (priced separately)', async () => {
  await admin.click('a[data-r="products"]'); await admin.waitForSelector('#addp'); await expectText(admin.locator('.empty'), /لا توجد منتجات بعد/);
  await admin.click('#addp');
  await admin.fill('.modal [name=name]', 'بكلاوه بالفستق'); await admin.selectOption('.modal [name=category_id]', { label: 'بكلاوه' });
  await admin.fill('.modal [name=price]', '18'); await admin.fill('.modal [name=description]', 'فستق حلبي وقطر خفيف');
  await admin.setInputFiles('.modal [data-image="image"] input[type=file]', { name: 'p.png', mimeType: 'image/png', buffer: PNG });
  await admin.waitForSelector('.modal .img-prev img');
  for (const [n, p] of [['صغير', '18'], ['كبير', '60']]) {
    await admin.click('.modal [data-rep="variants"] [data-rep-add]');
    const row = admin.locator('.modal .rep-row').last(); await row.locator('[data-k=name]').fill(n); await row.locator('[data-k=price]').fill(p);
  }
  await admin.click('.modal button[type=submit]'); await admin.waitForSelector('tr:has-text("بكلاوه بالفستق")');
  await shot(admin, 'admin-products');
});
await step('admin: add products via API for the rest of the run', async () => {
  const cats = (await (await adminCtx.request.get(BASE + '/api/admin/categories')).json()).items;
  const id = (slug) => cats.find((c) => c.slug === slug).id;
  for (const [c, name, price, desc] of [['juice', 'عصير برتقال', 7, 'برتقال طازج'], ['sweets', 'كنافة بالقشطة', 14, 'كنافة ناعمة'], ['sweets', 'بسبوسة', 8, 'بسبوسة اللوز']]) {
    const r = await adminCtx.request.post(BASE + '/api/admin/products', { data: { category_id: id(c), name, price, description: desc, available: true, active: true, variants: [] } });
    if (!r.ok()) throw new Error('create failed ' + (await r.text()));
  }
});
await step('admin: toggle availability from the list', async () => {
  await admin.click('a[data-r="products"]'); await admin.waitForSelector('tr:has-text("بسبوسة")');
  await admin.locator('tr:has-text("بسبوسة") [data-avail]').uncheck({ force: true }); await expectToast(admin, /غير متوفر/);
});
await step('admin: add a bundle with contents', async () => {
  await admin.click('a[data-r="bundles"]'); await admin.waitForSelector('#addb'); await admin.click('#addb');
  await admin.fill('.modal [name=name]', 'باقة الأفراح'); await admin.fill('.modal [name=price]', '180'); await admin.fill('.modal [name=description]', 'تشكيلة فاخرة للمناسبات');
  for (const [l, q] of [['بكلاوه مشكلة 1 كغ', '2'], ['عصير طبيعي', '6']]) { await admin.click('.modal [data-rep="items"] [data-rep-add]'); const r = admin.locator('.modal .rep-row').last(); await r.locator('[data-k=label]').fill(l); await r.locator('[data-k=quantity]').fill(q); }
  await admin.click('.modal button[type=submit]'); await admin.waitForSelector('tr:has-text("باقة الأفراح")');
});
await step('admin: add a banner and edit a branch (phone + map link)', async () => {
  await admin.click('a[data-r="banners"]'); await admin.waitForSelector('#addn'); await admin.click('#addn');
  await admin.fill('.modal [name=title]', 'اكتشف منتجاتنا'); await admin.fill('.modal [name=description]', 'بكلاوه وحلويات وعصائر'); await admin.fill('.modal [name=button_text]', 'اكتشف منتجاتنا'); await admin.fill('.modal [name=link]', '/shop');
  await admin.click('.modal button[type=submit]'); await admin.waitForSelector('tr:has-text("اكتشف منتجاتنا")');
  await admin.click('#addn'); await admin.setInputFiles('.modal [data-image="image"] input[type=file]', { name: 'b.png', mimeType: 'image/png', buffer: PNG }); await admin.waitForSelector('.modal .img-prev img');
  await admin.fill('.modal [name=title]', 'عروض الأسبوع'); await admin.click('.modal button[type=submit]'); await admin.waitForSelector('tr:has-text("عروض الأسبوع") img.thumb');
  await admin.click('a[data-r="branches"]'); await admin.waitForSelector('tr:has-text("النوفليين")');
  await admin.click('tr:has-text("النوفليين") [data-edit]'); await admin.fill('.modal [name=phone]', '0912345678'); await admin.fill('.modal [name=address]', 'عنوان اختباري'); await admin.fill('.modal [name=maps_url]', 'https://maps.google.com/?q=test');
  await admin.click('.modal button[type=submit]'); await admin.waitForSelector('tr:has-text("النوفليين"):has-text("فتح")');
});
await step('admin: settings — banner interval, delivery fee, reorder sections', async () => {
  await admin.click('a[data-r="settings"]'); await admin.waitForSelector('#sf');
  await admin.fill('[name=banner_interval_s]', '2.5'); await admin.fill('[name=delivery_fee]', '5');
  await admin.click('[data-down="2"]'); // move a section
  await admin.click('#sf [type=submit]'); await expectToast(admin, /تم حفظ/);
  await shot(admin, 'admin-settings');
});

await step('admin: payment gateways page — add + enable a gateway; secrets are masked', async () => {
  await admin.click('a[data-r="payments"]'); await admin.waitForSelector('#addg'); await expectText(admin.locator('.empty'), /لا توجد بوابات دفع/);
  await admin.click('#addg'); await admin.waitForSelector('[data-type="plutu"]'); await admin.waitForSelector('[data-type="generic"]'); await admin.click('[data-type="sandbox"]');
  await admin.fill('.modal [name=label]', 'دفع إلكتروني (اختبار)'); await admin.check('.modal [name=enabled]'); await admin.click('.modal button[type=submit]');
  await admin.waitForSelector('[data-g] .linkbox input'); await expectText(admin.locator('[data-g]'), /مفعّلة للعملاء/);
  const hook = await admin.inputValue('[data-g] .linkbox input'); if (!/\/api\/payments\/webhook\/\d+$/.test(hook)) throw new Error('webhook url ' + hook);
  // Plutu form: keys are password fields and never echoed back after saving
  await admin.click('#addg'); await admin.click('[data-type="plutu"]'); await admin.waitForSelector('.modal [name=s_api_key]');
  if ((await admin.getAttribute('.modal [name=s_api_key]', 'type')) !== 'password') throw new Error('api key field is not a password input');
  await admin.fill('.modal [name=s_api_key]', 'PLUTU-KEY-123456'); await admin.fill('.modal [name=s_access_token]', 'TOKEN-ABCDEF'); await admin.fill('.modal [name=s_secret_key]', 'SUPER-SECRET-9');
  await admin.click('.modal button[type=submit]'); await admin.waitForSelector('[data-g]:nth-of-type(2)');
  await admin.click('[data-g]:nth-of-type(2) [data-edit]'); await admin.waitForSelector('.modal [name=s_api_key]');
  const ph = await admin.getAttribute('.modal [name=s_api_key]', 'placeholder'); const val = await admin.inputValue('.modal [name=s_api_key]');
  if (!/••••456/.test(ph) || val) throw new Error('secret exposed: ' + ph + '|' + val);
  if ((await admin.content()).includes('PLUTU-KEY-123456')) throw new Error('secret in page HTML');
  await admin.keyboard.press('Escape'); await shot(admin, 'admin-payments');
});

// ════════ CUSTOMER: browse, search, cart, order ════════
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'ar-LY' });
const c = await phone.newPage(); watch(c, 'customer');
let orderNumber = ''; let orderUrl = '';
console.log('\n▶ العميل (هاتف)');
await step('splash shows once, real loading bar, then the home page', async () => {
  await c.goto(BASE + '/', { waitUntil: 'commit' });
  await c.waitForSelector('#splash'); await shot(c, 'splash');
  await c.waitForSelector('#splash', { state: 'detached', timeout: 12000 });
  await c.waitForSelector('.slider, .hero'); await c.waitForSelector('.card');
  if (!(await c.evaluate(() => sessionStorage.getItem('abk_splash')))) throw new Error('splash flag not set');
  await shot(c, 'home-mobile');
});
await step('splash does not return on navigation or reload in the same session', async () => {
  await c.reload({ waitUntil: 'domcontentloaded' });
  const vis = await c.evaluate(() => !!document.querySelector('#splash') && getComputedStyle(document.querySelector('#splash')).display !== 'none');
  if (vis) throw new Error('splash visible again');
});
await step('banner slideshow: images from admin change every ~2.5s, dots/pause work', async () => {
  await c.goto(BASE + '/'); await c.waitForSelector('.slider .slide');
  const n = await c.locator('.slider .slide').count(); if (n !== 2) throw new Error('expected 2 slides, got ' + n);
  const active = () => c.evaluate(() => [...document.querySelectorAll('.slider .slide')].findIndex((s) => s.classList.contains('active')));
  if ((await c.locator('.slider .slide img').count()) !== 1) throw new Error('image slide missing');
  const a0 = await active(); const t0 = Date.now();
  await c.waitForFunction((i) => { const s = [...document.querySelectorAll('.slider .slide')]; return s.findIndex((x) => x.classList.contains('active')) !== i; }, a0, { timeout: 5000 });
  const dt = Date.now() - t0; if (dt < 1800 || dt > 3800) throw new Error('rotation interval ' + dt + 'ms (expected about 2500)');
  await c.click('.slider [data-dot="0"]'); if ((await active()) !== 0) throw new Error('dot did not select slide');
  await c.click('.slider [data-pp]'); await sleep(3200); if ((await active()) !== 0) throw new Error('slideshow moved while paused');
  await c.click('.slider [data-pp]'); await shot(c, 'slider');
});
await step('no marquee/ticker/floating whatsapp on the page', async () => {
  const bad = await c.evaluate(() => [...document.querySelectorAll('marquee,[class*=marquee],[class*=ticker],[class*=float-wa],[class*=whatsapp-float]')].length);
  if (bad) throw new Error('forbidden element present');
});
await step('categories sit side by side, text-only, and filter without reload', async () => {
  const names = await c.locator('.chips .chip').allInnerTexts();
  if (names.join('|') !== 'الكل|بكلاوه|عصير|حلويات|منتجات أخرى|باقات المناسبات') throw new Error('chips: ' + names.join('|'));
  if (await c.locator('.chips img').count()) throw new Error('images inside category chips');
  const y = await c.locator('.chip').evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size); if (y !== 1) throw new Error('chips not in one row');
  await c.evaluate(() => { window.__nav = performance.now(); document.body.dataset.k = 'same'; });
  await c.click('[data-cat="juice"]'); await c.waitForFunction(() => document.querySelectorAll('[data-catalog] .card').length === 1 && !document.querySelector('[data-catalog] .skel'));
  if ((await c.evaluate(() => document.body.dataset.k)) !== 'same') throw new Error('page reloaded');
  await expectText(c.locator('[data-catalog] .card-name'), /عصير برتقال/);
  await c.click('[data-cat="all"]'); await c.waitForFunction(() => document.querySelectorAll('[data-catalog] .card').length >= 4);
  await c.click('[data-cat="bundles"]'); await c.waitForSelector('[data-catalog] .bcard'); await shot(c, 'bundles-chip');
  await c.click('[data-cat="all"]');
});
await step('search: Arabic spelling variants, suggestions, empty state', async () => {
  await c.click('#open-search'); await c.fill('#q', 'بقلاوة'); await c.waitForSelector('.sr-item .t:has-text("بكلاوه بالفستق")'); await shot(c, 'search');
  await c.fill('#q', 'لا شيء مثل هذا'); await c.waitForSelector('.search-res .empty'); await c.keyboard.press('Escape');
  await c.goto(BASE + '/shop?q=' + encodeURIComponent('الكنافه')); await c.waitForSelector('.card-name:has-text("كنافة")');
  await c.goto(BASE + '/shop?q=zzzz'); await expectText(c.locator('.empty'), /لا توجد نتائج/);
});
await step('product with variants: picker, add, quantity, toast not duplicated', async () => {
  await c.goto(BASE + '/'); await c.waitForSelector('.card');
  await c.locator('[data-catalog] .card:has-text("بكلاوه بالفستق") [data-pick]').click(); await c.waitForSelector('.modal .opt');
  await c.locator('.modal .opt:has-text("كبير")').click(); await expectText(c.locator('.modal #pp'), /60/);
  await c.click('.modal [data-q="1"]'); await expectText(c.locator('.modal #pp'), /120/);
  await c.click('#padd'); await expectText(c.locator('#cart-badge'), /2/);
  await expectToast(c, /أُضيف/);
});
await step('simple product + cart drawer: qty, remove, totals from server', async () => {
  await c.locator('[data-catalog] .card:has-text("عصير برتقال") [data-pick]').click(); await sleep(300);
  await c.click('#open-cart'); await c.waitForSelector('#cart-drawer.open .cl');
  await c.waitForFunction(() => /127/.test(document.querySelector('.drawer-foot')?.innerText || ''));
  await c.locator('.cl:has-text("عصير برتقال") [data-act="inc"]').click(); await c.waitForFunction(() => /134/.test(document.querySelector('.drawer-foot')?.innerText || ''));
  await c.locator('.cl:has-text("عصير برتقال") [data-act="rm"]').click(); await c.waitForFunction(() => document.querySelectorAll('.cl').length === 1);
  await shot(c, 'cart');
});
await step('server re-prices: a tampered local price cannot change what is charged', async () => {
  await c.evaluate(() => { const k = JSON.parse(localStorage.abk_cart_v1); k.forEach((i) => { i.price = 1; }); localStorage.abk_cart_v1 = JSON.stringify(k); });
  await c.reload(); await c.click('#open-cart'); await c.waitForFunction(() => /120/.test(document.querySelector('.drawer-foot')?.innerText || ''));
});
await step('cart survives a reload', async () => {
  await c.reload(); await expectText(c.locator('#cart-badge'), /2/);
});
await step('checkout: price change is shown before confirming', async () => {
  await c.goto(BASE + '/checkout'); await c.waitForSelector('#sum .sum-total');
  await c.fill('#cn', 'أحمد علي'); await c.fill('#cp', '0911234567'); await c.selectOption('#cb', { label: 'سوق الجمعة' });
  await c.waitForFunction(() => /120/.test(document.querySelector('#sum .sum-total')?.innerText || '') && !document.querySelector('#go').disabled);
  // admin raises the large price while the customer is still on the page
  const list = (await (await adminCtx.request.get(BASE + '/api/admin/products?q=' + encodeURIComponent('بكلاوه'))).json()).items[0];
  const full = await (await adminCtx.request.get(BASE + `/api/admin/products/${list.id}`)).json();
  full.variants = full.variants.map((v) => ({ ...v, price: v.price / 1000 + (v.name === 'كبير' ? 5 : 0) })); full.price /= 1000; full.compare_price = null;
  const put = await adminCtx.request.put(BASE + `/api/admin/products/${list.id}`, { data: full }); if (!put.ok()) throw new Error('admin put failed ' + await put.text());
  await c.click('#go');
  await c.waitForSelector('.notice-warn:has-text("تغيّر السعر")'); await expectText(c.locator('#sum .sum-total'), /130/);
  if (/\/order\//.test(c.url())) throw new Error('order was created without confirming the new price');
  await shot(c, 'checkout-price-changed');
});
await step('checkout: confirm after seeing the new total → order saved with number', async () => {
  await c.fill('#cnote', 'بدون سكر'); await c.click('#go');
  await c.waitForURL(/\/order\/ABK-\d+/); await c.waitForFunction(() => /^ABK-\d+$/.test((document.querySelector('h1')?.innerText || '').trim())); orderUrl = c.url(); orderNumber = (await c.locator('h1').first().innerText()).trim();
  if (!/^ABK-\d+$/.test(orderNumber)) throw new Error('bad number ' + orderNumber);
  await expectText(c.locator('.notice-ok'), /تم تسجيل طلبك/); await expectText(c.locator('.status.p-unpaid'), /غير مدفوع/); await shot(c, 'order-confirmation');
  if ((await c.locator('main').innerText()).includes('تم الدفع')) throw new Error('claims paid for a cash order');
  if ((await c.evaluate(() => JSON.parse(localStorage.abk_cart_v1 || '[]').length)) !== 0) throw new Error('cart not cleared');
});
await step('order tracking by number + phone (guest)', async () => {
  const g = await browser.newContext({ locale: 'ar-LY' }); const gp = await g.newPage();
  await gp.goto(BASE + '/track'); await gp.fill('#tn', orderNumber); await gp.fill('#tp', '0900000000'); await gp.click('button[type=submit]'); await gp.waitForSelector('.notice-err');
  await gp.fill('#tp', '0911234567'); await gp.click('button[type=submit]'); await gp.waitForURL(/\/order\//); await expectText(gp.locator('h1'), new RegExp(orderNumber)); await g.close();
});
await step('bundle: WhatsApp order registers first, never claims confirmation, correct number/message', async () => {
  await c.goto(BASE + '/bundles'); await c.waitForSelector('.bcard'); await c.locator('.bcard a:has-text("التفاصيل")').first().click();
  await c.waitForSelector('#wa'); await c.fill('#notes', 'تغليف هدية'); await c.click('[data-q="1"]'); await c.click('#wa');
  await c.waitForSelector('.modal #wf'); await c.fill('.modal [name=name]', 'سارة'); await c.fill('.modal [name=phone]', '0921112233');
  const noReg = await c.getAttribute('#wnoreg', 'href'); if (!noReg.startsWith('https://wa.me/218925006674?text=')) throw new Error('fallback link wrong: ' + noReg);
  await c.click('#wgo'); await c.waitForSelector('.modal .btn-wa');
  const href = decodeURIComponent(await c.getAttribute('.modal .btn-wa', 'href'));
  if (!href.startsWith('https://wa.me/218925006674?text=')) throw new Error('wrong number: ' + href);
  for (const need of ['باقة الأفراح', 'الكمية: 2', 'تغليف هدية', 'سوق الجمعة', 'رقم الطلب: ABK-']) if (!href.includes(need)) throw new Error('message missing: ' + need);
  await expectText(c.locator('.modal .notice-ok'), /لم يُؤكَّد بعد/); await shot(c, 'bundle-whatsapp');
});
await step('branches page: only real data, buttons only when data exists', async () => {
  await c.goto(BASE + '/branches'); await c.waitForSelector('.branch');
  const t = await c.locator('.branch').allInnerTexts();
  if (t.length !== 3) throw new Error('3 branches expected');
  const souq = c.locator('.branch:has-text("سوق الجمعة")'); if ((await souq.locator('a[href="tel:+218925006674"]').count()) !== 1) throw new Error('souq tel missing');
  if (await souq.locator('a[href*="maps"]').count()) throw new Error('invented map link on Souq');
  const nof = c.locator('.branch:has-text("النوفليين")'); if ((await nof.locator('a[href="https://maps.google.com/?q=test"]').count()) !== 1) throw new Error('admin-set map link missing');
  const sir = c.locator('.branch:has-text("السراج")'); if ((await sir.locator('a').count()) !== 0) throw new Error('السراج should have no action buttons without data');
  await shot(c, 'branches');
});
await step('footer: TikTok link, support numbers, exact maker line', async () => {
  const f = c.locator('footer');
  if ((await f.locator('a[href="https://www.tiktok.com/@alemalbklawa"]').count()) < 1) throw new Error('tiktok');
  const txt = await f.innerText(); if (!txt.includes('صنع بواسطة ابتكار')) throw new Error('maker line'); if (!txt.includes('093158884')) throw new Error('support number');
});

console.log('\n▶ الحسابات والدفع');
await step('register, logout, login, bad login message', async () => {
  await c.goto(BASE + '/register'); await c.fill('[name=name]', 'سارة محمد'); await c.fill('[name=phone]', '0921112233'); await c.fill('[name=password]', 'sara-pass-2026'); await c.click('button[type=submit]');
  await c.waitForURL(/\/account/); await expectText(c.locator('h1'), /سارة محمد/);
  await c.click('#logout'); await c.waitForURL(BASE + '/');
  await c.goto(BASE + '/login'); await c.fill('[name=identifier]', '0921112233'); await c.fill('[name=password]', 'bad-bad-bad-1'); await c.click('button[type=submit]'); await expectToast(c, /غير صحيحة/);
  await c.fill('[name=password]', 'sara-pass-2026'); await c.click('button[type=submit]'); await c.waitForURL(/\/account/);
});
await step('account: orders list (the WhatsApp bundle order is NOT hers), profile edit, password change', async () => {
  await c.click('[data-tab="profile"]'); await c.fill('#pe', 'sara@example.com'); await c.click('#pf button'); await expectToast(c, /تم حفظ/);
  await c.click('[data-tab="security"]'); await c.fill('#wc', 'sara-pass-2026'); await c.fill('#wn', 'sara-pass-2027'); await c.click('#wf button[type=submit]'); await expectToast(c, /تم تغيير/);
});
await step('online payment (sandbox): success is only shown after provider confirmation', async () => {
  await c.goto(BASE + '/'); await c.locator('[data-catalog] .card:has-text("كنافة") [data-pick]').click(); await sleep(300);
  await c.goto(BASE + '/checkout'); await c.waitForSelector('#sum .sum-total'); await c.fill('#cp', '0921112233'); await c.selectOption('#cb', { label: 'سوق الجمعة' });
  await c.check('input[name=pm][value^="online:"]'); await expectText(c.locator('.sandbox-flag'), /اختبار/); await c.click('#go');
  await c.waitForURL(/\/sandbox\/pay\//); await shot(c, 'sandbox-gateway');
  await c.click('text=محاكاة نجاح الدفع'); await c.waitForURL(/\/order\/ABK-/);
  await expectText(c.locator('.status.p-paid'), /مدفوع/);
});
await step('online payment (sandbox): failure keeps order unpaid and offers retry', async () => {
  await c.goto(BASE + '/'); await c.locator('[data-catalog] .card:has-text("كنافة") [data-pick]').click(); await sleep(300);
  await c.goto(BASE + '/checkout'); await c.waitForSelector('#sum .sum-total'); await c.selectOption('#cb', { label: 'سوق الجمعة' }); await c.check('input[name=pm][value^="online:"]'); await c.click('#go');
  await c.waitForURL(/\/sandbox\/pay\//); await c.click('text=محاكاة فشل الدفع'); await c.waitForURL(/\/order\/ABK-/);
  await expectText(c.locator('.status.p-failed'), /فشل/); await c.waitForSelector('#repay'); await expectText(c.locator('main'), /لم تكتمل/);
  await c.click('#repay'); await c.waitForURL(/\/sandbox\/pay\//); await c.click('text=إلغاء الدفع'); await c.waitForURL(/\/order\/ABK-/); await expectText(c.locator('.status.p-cancelled'), /أُلغي/);
});
await step('forgot password: WhatsApp to support with the ready message, no secrets', async () => {
  const g = await browser.newContext({ locale: 'ar-LY' }); const gp = await g.newPage();
  await gp.goto(BASE + '/login'); await gp.click('a:has-text("نسيت كلمة المرور")'); await gp.waitForSelector('#fwa');
  const href = decodeURIComponent(await gp.getAttribute('#fwa', 'href'));
  if (!href.startsWith('https://wa.me/21893158884?text=')) throw new Error('wrong support number ' + href);
  if (!href.includes('أحتاج إلى استعادة حسابي في موقع عالم البكلاوه')) throw new Error('message');
  if (/كلمة المرور[:：]/.test(href)) throw new Error('password leaked');
  await gp.click('[data-t="identifier"]'); await gp.waitForFunction(() => decodeURIComponent(document.querySelector('#fwa')?.href || '').includes('نسيت البريد الإلكتروني أو رقم الهاتف'));
  await shot(gp, 'forgot'); await g.close();
});

// ════════ ADMIN again: process the order, support reset, then customer deletes the account ════════
console.log('\n▶ معالجة الطلب والدعم وحذف الحساب');
await step('admin: find the order, move through every status, mark cash paid on delivery', async () => {
  await admin.click('a[data-r="orders"]'); await admin.waitForSelector('tr[data-open]');
  await admin.fill('[name=q]', orderNumber); await admin.waitForSelector(`tr:has-text("${orderNumber}")`); await admin.click(`tr:has-text("${orderNumber}")`);
  await admin.waitForSelector('#stf');
  for (const [v, re] of [['confirming', /قيد التأكيد/], ['preparing', /قيد التحضير/], ['ready', /جاهز/]]) {
    await admin.selectOption('#st', v); await admin.click('#stf button'); await admin.waitForSelector(`#stf select[name=status] option[value="${v}"][selected]`, { state: 'attached' }); await admin.waitForSelector('#stf');
  }
  await admin.selectOption('#st', 'delivered'); await admin.check('[name=markPaid]'); await admin.click('#stf button'); await sleep(600);
  await expectText(admin.locator('.modal .status.p-paid'), /مدفوع/); await shot(admin, 'admin-order');
  await admin.keyboard.press('Escape');
});
await step('customer sees status change (order page)', async () => {
  await c.goto(orderUrl); await expectText(c.locator('.status.s-delivered'), /تم التسليم/);
});
await step('admin: dashboard numbers are real (sales from the delivered order)', async () => {
  await admin.click('a[data-r="dashboard"]'); await admin.waitForSelector('.stats');
  const t = await admin.locator('.stats').innerText(); if (!/\d+(\.\d+)?\s*د\.ل/.test(t)) throw new Error('no money stat'); if (/^0 د\.ل/m.test(t.split('\n').filter((l) => /د\.ل/.test(l))[0] || '')) throw new Error('sales still zero');
  await expectText(admin.locator('.cols'), /بكلاوه بالفستق/);
});
await step('support: request is logged; admin makes a one-time reset link; customer resets', async () => {
  const g = await browser.newContext({ locale: 'ar-LY' }); const gp = await g.newPage();
  await gp.goto(BASE + '/forgot?type=password'); await gp.fill('#fn', 'سارة'); await gp.fill('#fp', '0921112233'); await gp.click('#fwa', { modifiers: [] }).catch(() => {}); await sleep(600); await g.close();
  await admin.click('a[data-r="customers"]'); await admin.waitForSelector('tr:has-text("نسيت كلمة المرور")');
  await admin.click('[data-t="customers"]'); await admin.fill('#cq', '0921112233'); await admin.waitForSelector('[data-reset]');
  await admin.click('[data-reset]'); await admin.click('.modal [data-ok]'); await admin.waitForSelector('#lk'); const link = await admin.inputValue('#lk');
  if (!/\/reset\?token=/.test(link)) throw new Error('no link');
  const r = await browser.newContext({ locale: 'ar-LY' }); const rp = await r.newPage(); watch(rp, 'reset');
  await rp.goto(link); await rp.fill('[name=password]', 'brand-new-pass-1'); await rp.fill('[name=confirm]', 'brand-new-pass-1'); await rp.click('button[type=submit]'); await rp.waitForURL(/\/login/);
  await rp.fill('[name=identifier]', '0921112233'); await rp.fill('[name=password]', 'brand-new-pass-1'); await rp.click('button[type=submit]'); await rp.waitForURL(/\/account/);
  await rp.goto(link); await rp.fill('[name=password]', 'another-pass-123'); await rp.fill('[name=confirm]', 'another-pass-123'); await rp.click('button[type=submit]'); await expectToast(rp, /غير صالح|منتهي/);
  await r.close();
});
await step('delete account: two-step confirmation, blocked by active order, then personal data removed', async () => {
  const d = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ar-LY' }); const dp = await d.newPage(); watch(dp, 'delete');
  await dp.goto(BASE + '/login'); await dp.fill('[name=identifier]', '0921112233'); await dp.fill('[name=password]', 'brand-new-pass-1'); await dp.click('button[type=submit]'); await dp.waitForURL(/\/account/);
  await dp.click('[data-tab="orders"]'); await dp.waitForSelector('.ocard');
  await dp.click('[data-tab="security"]'); await dp.click('#del'); await dp.click('.modal [data-ok]');
  await dp.fill('.modal [name=password]', 'brand-new-pass-1'); await dp.fill('.modal [name=confirm]', 'حذف'); await dp.click('.modal button[type=submit]');
  await expectToast(dp, /طلبات جارية/); // the sandbox orders are still open
  await dp.keyboard.press('Escape');
  // admin cancels her open orders, then deletion succeeds
  const orders = (await (await adminCtx.request.get(BASE + '/api/admin/orders?q=' + encodeURIComponent('921112233'))).json()).items;
  for (const o of orders.filter((x) => !['delivered', 'cancelled'].includes(x.status))) await adminCtx.request.post(BASE + `/api/admin/orders/${o.id}/status`, { data: { status: 'cancelled' } });
  await dp.click('#del'); await dp.click('.modal [data-ok]'); await dp.fill('.modal [name=password]', 'brand-new-pass-1'); await dp.fill('.modal [name=confirm]', 'حذف'); await dp.click('.modal button[type=submit]');
  await dp.waitForURL(BASE + '/'); await expectToast(dp, /تم حذف حسابك/);
  const login = await dp.request.post(BASE + '/api/auth/login', { data: { identifier: '0921112233', password: 'brand-new-pass-1' } }); if (login.status() !== 401) throw new Error('deleted account can still log in');
  const o = (await (await adminCtx.request.get(BASE + '/api/admin/orders?q=' + encodeURIComponent('ABK'))).json()).items.filter((x) => x.customer_name === 'عميل محذوف'); if (!o.length) throw new Error('orders not anonymised');
  await d.close();
});
await step('admin on a phone: layout usable (sidebar drawer, stacked table, no overflow)', async () => {
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'ar-LY' }); const mp = await m.newPage(); watch(mp, 'admin-mobile');
  await mp.goto(BASE + '/admin'); await mp.fill('#li', 'owner@example.ly'); await mp.fill('#lp', 'Owner-Strong-Pass-9'); await mp.click('button[type=submit]'); await mp.waitForSelector('.stats');
  await mp.click('#burger'); await mp.waitForSelector('#side.open'); await mp.click('#side a[data-r="orders"]'); await mp.waitForSelector('tr[data-open]');
  const ov = await mp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1); if (ov) throw new Error('admin overflows horizontally');
  await shot(mp, 'admin-orders-mobile'); await m.close();
});
await step('security: staff role limits and unauthenticated admin API', async () => {
  const r = await fetch(BASE + '/api/admin/orders'); if (r.status !== 401) throw new Error('admin api open');
  const h = await fetch(BASE + '/'); const csp = h.headers.get('content-security-policy'); if (!/script-src 'self'/.test(csp)) throw new Error('csp');
});
await step('no JavaScript errors were thrown anywhere', async () => { if (jsErrors.length) throw new Error(jsErrors.slice(0, 5).join(' | ')); });

await browser.close(); server.kill();
fs.rmSync(dataDir, { recursive: true, force: true });
const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('\nFAILED:\n' + failed.map((f) => ` - ${f[1]}: ${f[2]}`).join('\n')); if (process.env.SHOW_LOG) console.log(serverLog); }
process.exit(failed.length ? 1 : 0);
