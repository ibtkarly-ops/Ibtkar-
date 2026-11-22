"use strict";
// New site = "describe it -> send": the AI extracts the brief, asks for a missing phone, shows an editable plan card,
// "Build" creates + designs + publishes; "More details" opens the old wizard pre-filled.
const { launch } = require('./mock');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
const D1 = { brief: { name: 'مشويات الملكي', type: 'restaurant', desc: 'مطعم مشويات في طرابلس', tone: 'friendly', color: '#c0392b' }, items: [{ n: 'شاورما', c: '', p: '15', d: '' }, { n: 'كباب', c: '', p: '25', d: '' }], slug: 'almalaki' };
const D2 = { ...D1, brief: { ...D1.brief, phone: '0912345678' } };
const D3 = { ...D2, brief: { ...D2.brief, color: '#1d4ed8' } };
(async () => {
  const sent = [];
  let step = 0;
  const h = await launch({ role: 'customer', viewport: { width: 1100, height: 900 }, rpc: { slug_available: (b) => b.p_slug !== 'almalaki', request_publish: 'dep-1' },
    tables: { websites: [], website_versions: [] },
    functions: {
      'ai-gateway': (b) => {
        sent.push(b);
        if (b.action === 'site_chat') { step++; return step === 1 ? { ok: true, type: 'question', text: 'ما رقم الهاتف أو الواتساب الذي يتواصل عليه العملاء؟', draft: D1, missing: ['phone'] } : step === 2 ? { ok: true, type: 'plan', text: 'هذه خطة موقعك', draft: D2, missing: [] } : { ok: true, type: 'plan', text: 'غيّرت اللون للأزرق', draft: D3, missing: [] }; }
        if (b.action === 'design') return { ok: true, copy: { hero: { t: 'أطيب مشويات', s: 'في طرابلس' } }, items: null, model: 'm' };
        return { ok: false, error: 'x' };
      },
      'verify-publish': { ok: true, url: 'https://x.pages.dev/almalaki-2' },
    } });
  const { page } = h;
  await h.open('#/app/new'); await page.waitForSelector('form[data-form="nsmsg"]', { timeout: 8000 });
  check('new site opens on "describe your site" with examples and a manual-form link', (await page.locator('.ac-hello .chip').count()) === 4 && (await page.locator('a[href="#/app/new/form"]').count()) >= 1 && (await page.locator('form[data-form="wizard"]').count()) === 0);
  await page.click('.ac-hello .chip'); check('example fills the box', (await page.locator('form[data-form="nsmsg"] textarea').inputValue()).length > 20);
  await page.fill('form[data-form="nsmsg"] textarea', 'مطعم مشويات اسمه الملكي في طرابلس، شاورما 15 وكباب 25');
  await page.press('form[data-form="nsmsg"] textarea', 'Enter');
  await page.waitForSelector('.ac-b.a', { timeout: 6000 });
  check('Enter sends to site_chat with the language', sent[0] && sent[0].action === 'site_chat' && /الملكي/.test(sent[0].message) && sent[0].lang === 'ar' && !sent[0].draft);
  check('missing phone -> one question, no build button yet', /رقم الهاتف/.test(await page.locator('#nsm').innerText()) && (await page.locator('[data-act="nsbuild"]').count()) === 0);
  await page.fill('form[data-form="nsmsg"] textarea', '0912345678'); await page.click('form[data-form="nsmsg"] button');
  await page.waitForSelector('.nsplan [data-act="nsbuild"]', { timeout: 6000 });
  check('second message carries the draft and history', sent[1].draft && sent[1].draft.brief.name === 'مشويات الملكي' && sent[1].history.length === 2);
  check('plan card: editable name, link, phone, type, colours and items', await page.inputValue('.nsplan [data-ns="name"]') === 'مشويات الملكي' && await page.inputValue('#sl') === 'almalaki' && await page.inputValue('.nsplan [data-ns="phone"]') === '0912345678' && await page.inputValue('.nsplan select[data-ns="type"]') === 'restaurant' && (await page.locator('.nsplan .pl-s .chip').count()) === 2 && (await page.locator('.nsc button').count()) >= 4);
  await page.waitForTimeout(600);
  check('link availability is checked right away (taken)', /✗/.test(await page.locator('#slst').innerText()));
  // a follow-up message updates the plan
  await page.fill('form[data-form="nsmsg"] textarea', 'غيّر اللون للأزرق'); await page.click('form[data-form="nsmsg"] button');
  await page.waitForFunction(() => /غيّرت اللون/.test((document.querySelector('.nsplan p') || {}).textContent || ''), null, { timeout: 6000 });
  check('only the newest plan card stays (older ones collapse to text, one link field)', (await page.locator('.nsplan').count()) === 1 && (await page.locator('[data-act="nsbuild"]').count()) === 1 && (await page.locator('#sl').count()) === 1);
  await page.fill('.nsplan [data-ns="name"]', 'مشويات الملكي الأصلي');
  // the draft survives a reload
  // (a full reload is not used: headless Chromium sometimes drops file:// localStorage on reload; the draft is read back from storage either way)
  await page.evaluate(() => { location.hash = '#/app/sites'; }); await page.waitForTimeout(500);
  await page.evaluate(() => { location.hash = '#/app/new'; }); await page.waitForSelector('.nsplan [data-act="nsbuild"]', { timeout: 8000 });
  check('draft is kept when leaving and coming back (with the edited name)', await page.inputValue('.nsplan [data-ns="name"]') === 'مشويات الملكي الأصلي');
  // "More details" opens the wizard pre-filled
  await page.click('[data-act="nsform"]'); await page.waitForSelector('form[data-form="wizard"]', { timeout: 8000 }); await page.waitForTimeout(300);
  check('wizard pre-filled from the AI draft', await page.inputValue('input[name=name]') === 'مشويات الملكي الأصلي' && await page.inputValue('input[name=phone]') === '0912345678' && /مشويات/.test(await page.inputValue('textarea[name=desc]')) && await page.locator('input[name=type][value=restaurant]').isChecked() && (await page.inputValue('textarea[name=items]')).startsWith('شاورما|15|'));
  await page.click('a[href="#/app/new"]'); await page.waitForSelector('.nsplan [data-act="nsbuild"]', { timeout: 8000 });
  // build
  await page.click('[data-act="nsbuild"]'); await page.waitForSelector('#bo.ok, #bo.err', { timeout: 15000 });
  const ins = h.calls.find((c) => c.method === 'POST' && /\/websites/.test(c.url));
  const br = ins && ins.body.config.brief;
  check('build creates the site with the extracted brief', ins && ins.body.site_type === 'restaurant' && br.name === 'مشويات الملكي الأصلي' && br.phone === '0912345678' && br.color === '#1d4ed8' && /^شاورما\|15\|/.test(br.items) && br.dna);
  check('taken link gets a free variant automatically', ins && ins.body.slug === 'almalaki-2');
  check('AI design ran and the site was published', sent.some((b) => b.action === 'design') && /pages\.dev/.test(await page.locator('#bo').innerText()));
  check('draft cleared after building', await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('nsd:')).length === 0));
  check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
  await h.close();

  // no AI provider: clear message + manual form link
  const h2 = await launch({ role: 'customer', viewport: { width: 390, height: 844 }, functions: { 'ai-gateway': { ok: false, error: 'service_not_configured' } } });
  await h2.open('#/app/new'); await h2.page.waitForSelector('form[data-form="nsmsg"]', { timeout: 8000 });
  await h2.page.fill('form[data-form="nsmsg"] textarea', 'متجر ورد'); await h2.page.click('form[data-form="nsmsg"] button');
  await h2.page.waitForSelector('.ac-b.e', { timeout: 6000 });
  check('no AI: error shown with a manual-form button, text kept', (await h2.page.locator('.ac-b.e a[href="#/app/new/form"]').count()) === 1 && await h2.page.inputValue('form[data-form="nsmsg"] textarea') === 'متجر ورد');
  const sw = await h2.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('phone width: no horizontal scroll', sw <= 1);
  await h2.close();
  process.exit(fails ? 2 : 0);
})();
