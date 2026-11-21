"use strict";
// Every new site gets a random "design DNA" (hero, item layout, fonts, palette, page/hero theme, shape,
// decoration, section order, buttons, header). Goal: two sites share the same main design < 1% of the time,
// and every combination still honours the page contracts the rest of the platform relies on.
const { launch } = require('./mock');
const { chromium } = require('playwright');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
(async () => {
  const h = await launch({ role: 'customer', signedIn: false });
  await h.open('#/'); await h.page.waitForTimeout(300);

  // ---- collision rate of the main visual combination, per type ----
  const rates = await h.page.evaluate(() => Object.fromEntries(['landing', 'company', 'store', 'restaurant'].map((ty) => {
    const keys = Array.from({ length: 400 }, () => dnaKey(newDNA(ty), ty));
    let same = 0, pairs = 0;
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) { pairs++; if (keys[i] === keys[j]) same++; }
    return [ty, same / pairs];
  })));
  for (const [ty, r] of Object.entries(rates)) check(`${ty}: two random sites share the main design ${(r * 100).toFixed(3)}% of the time (< 1%)`, r < 0.01);

  // ---- every hero x item-layout combination keeps the contracts ----
  const res = await h.page.evaluate(() => {
    const out = [];
    for (const ty of ['landing', 'company', 'store', 'restaurant']) {
      for (const hero of DNA_OPT.hero[ty]) for (const feat of DNA_OPT.feat[ty]) {
        const dna = { ...newDNA(ty), hero, feat };
        const b = { name: 'نموذج', type: ty, lang: 'ar', phone: '0912345678', wa: '0912345678', desc: 'وصف', color: '#0f766e', banner: 'عرض خاص', dna };
        const html = genSite(b), sd = readSD(html);
        out.push({ ty, hero, feat, ok: !!sd && sd.items.length > 0 && /id="items-list"/.test(html) && /<!--sd-->[\s\S]+<!--\/sd-->/.test(html) && /id="promo-banner"/.test(html) && /data-animated-bg="/.test(html) && /id="wa-float"/.test(html) && (ty !== 'store' || /id="cart"/.test(html)) && /name="ibtikar-tpl" content="6"/.test(html),
          layoutOk: ty === 'store' ? sd.layout === 'cards' : ty === 'restaurant' ? sd.layout === 'menu' : ty === 'company' ? sd.layout === 'svc' : ['svc', 'bento'].includes(sd.layout) });
      }
    }
    return out;
  });
  const bad = res.filter((r) => !r.ok || !r.layoutOk);
  check(`all ${res.length} hero x layout combinations keep site-data, static items, promo, animated bg, WhatsApp, cart and the v6 mark`, bad.length === 0 || (console.log(bad), false));

  // ---- a stored DNA is stable: same brief -> same page; bad values are replaced by valid ones ----
  const stable = await h.page.evaluate(() => {
    const b = { name: 'ثابت', type: 'landing', phone: '0912345678', dna: newDNA('landing') };
    const c = cleanDNA({ hero: 'nope', feat: 'bento', font: 99 }, 'landing');
    return { same: genSite(b) === genSite(b), clean: DNA_OPT.hero.landing.includes(c.hero) && c.feat === 'bento' && c.font >= 0 && c.font < FONTS.length };
  });
  check('a saved DNA renders the same page every time', stable.same);
  check('invalid DNA values are replaced with valid ones', stable.clean);

  // ---- AI copy + extra sections are rendered and escaped; unsafe CSS is dropped ----
  const copy = await h.page.evaluate(() => genSite({ name: 'نص', type: 'landing', phone: '0912345678', wa: '0912345678', dna: newDNA('landing'),
    copy: { hero: { t: 'عنوان <b>رئيسي</b>', s: 'وصف' }, faq: [{ q: 'سؤال مخصّص؟', a: 'جواب' }], sections: [{ type: 'stats', title: 'بالأرقام', items: [{ v: '+500', l: 'عميل' }] }, { type: 'pricing', items: [{ n: 'باقة', p: '50', f: ['ميزة'] }] }, { type: 'gallery', items: ['https://evil.example/x.png'] }] },
    custom_css: 'body{color:red}</style><script>alert(1)</script>@import url(x)' }));
  check('AI headline is used and escaped', copy.includes('عنوان &lt;b&gt;رئيسي&lt;/b&gt;'));
  check('custom FAQ replaces the default one', copy.includes('سؤال مخصّص؟'));
  check('stats + pricing sections rendered', copy.includes('class="xstats"') && copy.includes('class="grid xprice"'));
  check('gallery refuses images outside our storage', !copy.includes('evil.example'));
  check('custom CSS cannot break out of <style> or import', !/<script>alert|@import|url\(x\)/.test(copy) && copy.includes('body{color:red}'));
  await h.close();

  // ---- a sample of variants actually runs without script errors ----
  const htmls = await (async () => { const b = await launch({ role: 'customer', signedIn: false }); await b.open('#/'); await b.page.waitForTimeout(200);
    const r = await b.page.evaluate(() => ['landing', 'landing', 'landing', 'company', 'store', 'restaurant'].map((ty) => genSite({ name: 'تشغيل', type: ty, lang: 'ar', phone: '0912345678', wa: '0912345678', desc: 'x', dna: newDNA(ty), items: 'أ|10|ب\nج|20|د\nه|30|و' })));
    await b.close(); return r; })();
  const br = await chromium.launch(), ctx = await br.newContext({ viewport: { width: 390, height: 844 } });
  let errs = [];
  for (const html of htmls) {
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await p.route('**/*', (r) => r.abort());
    await p.setContent(html); await p.waitForTimeout(250);
    const n = await p.locator('#items-list .item').count(); if (n !== 3) errs.push('items rendered: ' + n);
    await p.close();
  }
  await br.close();
  check('random variants render their items with no script errors', errs.length === 0 || (console.log(errs), false));
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 2 : 0);
})();
