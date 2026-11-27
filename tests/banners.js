"use strict";
// Several promo banners (text + image + link), the logo in the hero, item photos and the page-wide animated background:
// template rendering, the Items tab editor and the creation wizard.
const { launch, UID } = require('./mock');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
const IMG = 'https://ppegbmqkcdwopakewetl.supabase.co/storage/v1/object/public/site-assets/s1/b1.webp';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
(async () => {
  // ---- 1) template ----
  const boot = await launch({ role: 'customer', viewport: { width: 1280, height: 800 } }); await boot.open('#/'); await boot.page.waitForTimeout(300);
  const b = { name: 'رويال', type: 'store', lang: 'ar', wa: '0912345678', desc: 'متجر', logo: IMG, banners: [{ t: 'تخفيضات الصيف', img: IMG, u: 'https://example.com/sale' }, { t: 'وصل حديثاً', img: IMG }, { t: 'توصيل مجاني' }, { t: 'x', img: 'javascript:alert(1)', u: 'javascript:alert(1)' }] };
  const html = await boot.page.evaluate((b) => genSite(b), b);
  const p = await boot.context.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.setContent(html); await p.waitForTimeout(400);
  check('one hero slide per banner (+ the main one)', await p.locator('.hero .slide').count() === 5);
  check('banner images become full-bleed hero layers (one per banner + the first photo behind the opening slide)', await p.locator('.hero .himg').count() === 3 && await p.locator('.hero .himg.on[data-k="0"]').count() === 1);
  check('unsafe banner image/link are dropped', !/javascript:/.test(html));
  check('banner link becomes a button', await p.locator('.slide a.btn[href="https://example.com/sale"]').count() === 1);
  check('logo shown in the hero', await p.locator('.slide .hlogo').count() === 1);
  check('no promo strip: banners live only in the hero slides', (await p.locator('#promo-banner, .promo').count()) === 0);
  check('page-wide animated background layer', await p.locator('.amb i').count() === 3);
  await p.locator('.dots i').nth(1).click(); await p.waitForTimeout(300);
  check('switching slide shows its image', await p.locator('.himg.on').count() === 1 && (await p.locator('.himg.on').getAttribute('data-k')) === '1');
  await p.waitForTimeout(5000);
  check('no page errors', errs.length === 0 || (console.log(errs), false));
  // AI page with several banners: writeSD adds the small rotator once
  const ai = '<html><body><div id="promo-banner"><b>عرض</b><a href="#">واتساب</a></div><div id="items-list"><!--sd--><!--/sd--></div><script type="application/json" id="site-data">{"items":[{"n":"a"}]}</script></body></html>';
  const ai2 = await boot.page.evaluate((h) => writeSD(writeSD(h, { items: [{ n: 'a' }], banners: [{ t: 'أول' }, { t: 'ثاني' }] }), { items: [{ n: 'a' }], banners: [{ t: 'أول' }, { t: 'ثاني' }] }), ai);
  check('AI page gets the banner rotator once', (ai2.match(/id="ibk-bn"/g) || []).length === 1);
  await p.setContent(ai2); await p.waitForTimeout(4800);
  check('AI page promo text rotates, links untouched', (await p.locator('#promo-banner b').innerText()) === 'ثاني' && (await p.locator('#promo-banner a').innerText()) === 'واتساب');
  await boot.close();

  // ---- 2) Items tab editor ----
  const base = await (async () => { const x = await launch({ role: 'customer' }); await x.open('#/'); await x.page.waitForTimeout(200); const hh = await x.page.evaluate(() => genSite({ name: 'ملكي', type: 'store', lang: 'ar', phone: '0912345678', desc: 'متجر' })); await x.close(); return hh; })();
  const w = { id: 's1', owner_id: UID, name: 'ملكي', slug: 'royal', site_type: 'store', status: 'draft', created_at: new Date().toISOString(), config: { html: base, brief: { name: 'ملكي', type: 'store', lang: 'ar', phone: '0912345678', desc: 'متجر' } } };
  const h = await launch({ role: 'customer', tables: { websites: [w], website_versions: [] } });
  const { page } = h;
  await h.open('#/app/site/s1/items'); await page.waitForSelector('form[data-form="items"]', { timeout: 8000 });
  check('banners card shown', await page.locator('#bnrows').count() === 1);
  await page.click('[data-act="bnadd"]'); await page.click('[data-act="bnadd"]');
  await page.locator('.brow').nth(0).locator('[data-b=t]').fill('خصم 20%');
  await page.locator('.brow').nth(0).locator('[data-up=banner]').setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: png });
  await page.waitForTimeout(800);
  check('banner image uploaded to the site folder', h.calls.some((c) => c.method === 'POST' && /storage\/v1\/object\/site-assets\/s1\/.+\.webp/.test(c.url)) && /site-assets\/s1\//.test(await page.locator('.brow').nth(0).locator('[data-b=img]').inputValue()));
  await page.locator('.brow').nth(1).locator('[data-b=t]').fill('توصيل مجاني');
  await page.click('[data-act="bnadd"]'); await page.locator('.brow').nth(2).locator('[data-act=bnrm]').click();
  check('banner rows can be removed', await page.locator('.brow').count() === 2);
  await page.click('form[data-form="items"] button.btn.p'); await page.waitForTimeout(900);
  const v = h.calls.filter((c) => c.method === 'POST' && /website_versions/.test(c.url)).pop();
  const saved = v && v.body.snapshot.html;
  const sd = saved && await page.evaluate((x) => readSD(x), saved);
  check('banners saved into site-data', sd && sd.banners && sd.banners.length === 2 && sd.banners[0].t === 'خصم 20%' && /site-assets\/s1\//.test(sd.banners[0].img));
  check('template page re-generated with the banner slides', /class="himg"/.test(saved) && /خصم 20%/.test(saved) && sd.items.length === 8);
  const up = h.calls.filter((c) => c.method === 'PATCH' && /\/websites/.test(c.url)).map((c) => c.body).find((x) => x && x.config && x.config.brief && x.config.brief.banners);
  check('brief keeps the banners (for rebuilds)', up && up.config.brief.banners.length === 2);
  await h.close();

  // ---- 3) wizard: logo + banner image + item photo ----
  const z = await launch({ role: 'customer', viewport: { width: 1280, height: 900 }, rpc: { slug_available: true, request_publish: 'dep-1' }, functions: { 'ai-gateway': { ok: false, error: 'service_not_configured' }, 'verify-publish': { ok: true, url: 'https://x.pages.dev/royal' } }, tables: { websites: [], website_versions: [] } });
  const zp = z.page;
  await z.open('#/app/new/form'); await zp.waitForSelector('form[data-form="wizard"]');
  const next = async () => { await zp.click('[data-act="wznext"]'); await zp.waitForTimeout(120); };
  await zp.fill('textarea[name=desc]', 'متجر تزلج'); await zp.click('.tc:nth-child(2)'); await next();
  await zp.fill('input[name=name]', 'رويال'); await zp.fill('#sl', 'royalx'); await zp.waitForTimeout(700); await next();
  await zp.fill('input[name=phone]', '0912345678'); await next();
  const r0 = zp.locator('#wzitems .wzrow').nth(0);
  await r0.locator('[data-wi=n]').fill('حذاء'); await r0.locator('[data-wi=p]').fill('150');
  await r0.locator('[data-pv]').setInputFiles({ name: 'i.png', mimeType: 'image/png', buffer: png });
  check('item photo previews in the wizard', await r0.locator('.ip').isVisible());
  await next(); await next();
  await zp.locator('#wzLogo').setInputFiles({ name: 'l.png', mimeType: 'image/png', buffer: png });
  await zp.locator('.brow').nth(0).locator('[data-b=t]').fill('افتتاح جديد');
  await zp.locator('.brow').nth(0).locator('[data-pv]').setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: png });
  await zp.click('[data-act="bnadd"]'); await zp.locator('.brow').nth(1).locator('[data-b=t]').fill('عروض الأسبوع');
  await next(); await zp.click('#wzgo'); await zp.waitForSelector('#bo.ok, #bo.err', { timeout: 15000 });
  const ups = z.calls.filter((c) => c.method === 'POST' && /storage\/v1\/object\/site-assets\//.test(c.url));
  check('wizard uploads logo, banner image and item photo (3 files)', ups.length === 3);
  const zv = z.calls.find((c) => c.method === 'POST' && /website_versions/.test(c.url));
  const zh = zv && zv.body.snapshot.html, zsd = zh && await zp.evaluate((x) => readSD(x), zh);
  check('site built with logo, banner slides and the item photo', /class="hlogo"/.test(zh) && /class="himg"/.test(zh) && /افتتاح جديد/.test(zh) && zsd.items[0].img && zsd.banners.length === 2 && !!zsd.logo);
  const zb = z.calls.filter((c) => c.method === 'PATCH' && /\/websites/.test(c.url)).map((c) => c.body).find((x) => x && x.config && x.config.brief && x.config.brief.banners);
  check('brief saved with logo + banners (no File objects)', zb && zb.config.brief.logo && zb.config.brief.banners[0].img && zb.config.brief.banner === 'افتتاح جديد' && !JSON.stringify(zb).includes('_f'));
  check('no page errors', z.errors.length === 0 || (console.log(z.errors), false));
  await z.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 2 : 0);
})();
