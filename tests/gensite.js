"use strict";
// genSite(): full site (hero/about/items/how/faq/contact) + site-data block that renders and is editable.
const { launch } = require('./mock');
const fs = require('fs');
const out = process.argv[2] || '/tmp/shots';
fs.mkdirSync(out, { recursive: true });
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
(async () => {
  const h = await launch({ role: 'customer', viewport: { width: 390, height: 844 } });
  await h.open('#/');
  await h.page.waitForTimeout(500);
  const cases = [
    ['store', { name: 'ملكي', type: 'store', lang: 'ar', phone: '0912345678', wa: '0912345678', desc: 'متجر', color: '#2433ff', style: 'modern' }],
    ['rest-both', { name: 'Royal', type: 'restaurant', lang: 'both', phone: '0912345678', desc: 'مطعم', color: '#b45309', style: 'classic' }],
    ['own-items', { name: 'ملكي', type: 'company', lang: 'ar', phone: '0912345678', desc: 'شركة', items: 'تصميم|50 د.ل|وصف\nتطوير', color: '#0f766e', style: 'bold' }],
  ];
  for (const [n, b] of cases) {
    const html = await h.page.evaluate((b) => genSite(b), b);
    const sd = await h.page.evaluate((x) => readSD(x), html);
    check(n + ': site-data present', sd && sd.items.length >= 2);
    const p = await h.context.newPage();
    await p.setViewportSize({ width: 390, height: 844 });
    const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.setContent(html);
    await p.waitForTimeout(300);
    const cnt = await p.locator('#items-list .item').count();
    check(n + ': items rendered (' + cnt + ')', cnt === sd.items.length);
    check(n + ': no page errors', errs.length === 0);
    if (n === 'store') {
      check('store: no invented prices', sd.sample === true && sd.items.every((i) => !i.p));
      check('store: add-to-cart buttons + cart button', (await p.locator('#items-list .add').count()) === sd.items.length && (await p.locator('#cart-btn').isVisible()));
      check('store: template version mark', /name="ibtikar-tpl" content="7"/.test(html) && sd.layout === 'cards');
      await p.click('#filters button:nth-child(2)'); await p.waitForTimeout(100);
      check('store: category filter works', (await p.locator('#items-list .item').count()) < sd.items.length);
    }
    if (n === 'own-items') check('own items kept (no sample flag)', !sd.sample && sd.items[0].p === '50 د.ل');
    if (n === 'rest-both') check('restaurant: menu layout (rows + category headings)', sd.layout === 'menu' && (await p.locator('#items-list .item.row').count()) === sd.items.length && (await p.locator('#items-list .mcat').count()) >= 2);
    if (n === 'own-items') check('company: service cards with icons', sd.layout === 'svc' && (await p.locator('#items-list .svc .sic svg').count()) >= 1);
    // nothing the owner did not give: no ready-made "why us / how to order / FAQ / ready to start?" filler
    check(n + ': no canned filler sections (timeline, FAQ, CTA band, why-us cards)', (await p.locator('.tl li, details, .band').count()) === 0 && !/خدمة بعناية|كيف أطلب؟|جاهز للبدء|Careful service|How do I order/.test(html));
    if (n === 'own-items') check('company with prices also gets the cart (phone doubles as WhatsApp)', (await p.locator('#items-list .add').count()) === sd.items.length);
    // editing the JSON block is picked up by the renderer
    const html2 = await h.page.evaluate(([x]) => writeSD(x, { items: [{ n: 'جديد </script>', c: '', p: '5', d: '' }] }), [html]);
    await p.setContent(html2); await p.waitForTimeout(200);
    check(n + ': edited block renders & is escaped', (await p.locator('#items-list .item').count()) === 1 && (await p.locator('#items-list h3').innerText()).includes('</script>'));
    await p.setContent(html);
    await p.waitForTimeout(200);
    await p.screenshot({ path: `${out}/site-${n}.png`, fullPage: true });
    await p.close();
  }
  // ---- what the owner (or the AI, from the owner's description) wrote IS shown ----
  {
    const copy = { steps: [{ t: 'اختر الخدمة', d: 'من القائمة' }, { t: 'نتواصل معك' }], faq: [{ q: 'هل يوجد توصيل؟', a: 'نعم داخل طرابلس' }], band: { t: 'ابدأ مشروعك اليوم', s: 'نرد خلال ساعة' } };
    const hh = await h.page.evaluate((c) => genSite({ name: 'ملكي', type: 'company', lang: 'ar', phone: '0912345678', desc: 'شركة', color: '#0f766e', style: 'bold', copy: c }), copy);
    const p = await h.context.newPage(); await p.setContent(hh); await p.waitForTimeout(200);
    check('owner steps become the timeline, owner FAQ and closing band are shown', (await p.locator('.tl li').count()) === 2 && /هل يوجد توصيل؟/.test(await p.locator('details').innerText()) && /ابدأ مشروعك اليوم/.test(await p.locator('.band').innerText()));
    const bare = await h.page.evaluate(() => genSite({ name: 'ملكي', type: 'landing', lang: 'ar', phone: '0912345678', color: '#0f766e' }));
    await p.setContent(bare); await p.waitForTimeout(200);
    check('no description: no empty "about" section and no link to it', (await p.locator('#about').count()) === 0 && (await p.locator('a[href="#about"]').count()) === 0);
    await p.close();
  }
  // ---- effects the customer asked for: promo banner, animated background, motion, floating WhatsApp ----
  const royal = { name: 'رويال سكيت', type: 'store', lang: 'both', phone: '0931588884', wa: '0931588884', desc: 'متجر إلكتروني أول ما يدخل خلفية متحركة وبانر إعلاني', notes: 'بانر إعلاني وخلفية متحركة وانيميشن قوي', usp: 'أسرع وأرخص موفر قطع الباتيناج', items: 'Yy|1|', color: '#2433ff', style: 'modern' };
  const fxHtml = await h.page.evaluate((b) => genSite(b), royal);
  const fp = await h.context.newPage(); await fp.setViewportSize({ width: 1280, height: 800 }); await fp.setContent(fxHtml); await fp.waitForTimeout(1500);
  check('no promo strip at the top of the page', (await fp.locator('#promo-banner, .promo').count()) === 0 && await fp.evaluate(() => document.body.firstElementChild.id !== 'promo-banner'));
  check('animated background layer present (data-animated-bg)', (await fp.locator('.hero [data-animated-bg="aurora"]').count()) === 1 && /@keyframes gs/.test(fxHtml));
  check('no floating WhatsApp button or bar', (await fp.locator('#wa-float').count()) === 0 && !/id="wa-float"/.test(fxHtml));
  check('store: products come right after the hero (before about)', await fp.evaluate(() => document.querySelector('#items').compareDocumentPosition(document.querySelector('#about')) & Node.DOCUMENT_POSITION_FOLLOWING));
  check('selling point shown as a card', (await fp.locator('#about .card').first().innerText()).includes('الباتيناج'));
  await fp.screenshot({ path: out + '/fx-hero.png' });
  await fp.evaluate(() => window.scrollTo(0, 900)); await fp.waitForTimeout(900); await fp.screenshot({ path: out + '/fx-scroll.png' });
  check('scroll reveal adds .in to cards', (await fp.locator('.rv.in').count()) > 0);
  for (const bg of ['particles', 'waves']) {
    const hh = await h.page.evaluate(([b, g]) => genSite({ ...b, bg: g }), [royal, bg]);
    await fp.setContent(hh); await fp.waitForTimeout(500);
    check(bg + ' background renders', (await fp.locator(bg === 'particles' ? '.bg-anim canvas' : '.bg-anim svg').count()) >= 1);
  }
  const off = await h.page.evaluate((b) => genSite({ ...b, bg: 'none', motion: 'none', banner: '', notes: '', desc: 'x', type: 'company', float: '0' }), royal);
  check('the effects can still be switched off, and no strip/float ever exists', !/id="promo-banner"/.test(off) && !/data-animated-bg="/.test(off) && !/id="wa-float"/.test(off));
  const own = await h.page.evaluate((b) => genSite({ ...b, banner: 'خصم 20% هذا الأسبوع' }), royal);
  check('custom banner text is used', /خصم 20% هذا الأسبوع/.test(own));
  await fp.close();
  // SEO: items + JSON-LD are present without running any JavaScript
  const html = await h.page.evaluate(() => genSite({ name: 'ملكي', type: 'store', lang: 'ar', phone: '0912345678', desc: 'متجر', logo: 'https://x.supabase.co/storage/v1/object/public/site-assets/s/l.webp', color: '#2433ff', style: 'modern' }));
  const ctx = await h.browser.newContext({ javaScriptEnabled: false }); const np = await ctx.newPage(); await np.setContent(html);
  check('no-JS: items visible in static HTML', (await np.locator('#items-list .item').count()) >= 4);
  check('logo shown in header + og:image', (await np.locator('#site-logo').count()) === 1 && /og:image/.test(html));
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
  check('JSON-LD valid (name, phone, image)', ld.name === 'ملكي' && ld.telephone === '+218912345678' && !!ld.image);
  await ctx.close();
  await h.close();
  process.exit(fails ? 2 : 0);
})();
