"use strict";
// Apps: menu item for everyone, "coming soon" + interest form for customers/visitors, AI wizard for the super admin.
const { launch } = require('./mock');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
(async () => {
  // customer
  let h = await launch({ role: 'customer', viewport: { width: 1000, height: 800 } });
  await h.open('#/app/apps'); await h.page.waitForSelector('form[data-form="interest"]', { timeout: 8000 });
  check('customer: menu has Apps row', (await h.page.locator('#drawer .dr-i[href="#/app/apps"]').count()) === 1 && (await h.page.locator('#drawer .dr-i[href="#/app/apps"].on').count()) === 1);
  check('customer: coming soon, no wizard', (await h.page.locator('text=قريباً').count()) > 0 && (await h.page.locator('form[data-form="newapp"]').count()) === 0);
  await h.page.fill('form[data-form="interest"] input[name=email]', 'a@b.ly'); await h.page.click('form[data-form="interest"] button');
  await h.page.waitForTimeout(300);
  check('customer: interest saved', h.calls.some((c) => c.method === 'POST' && /interest_signups/.test(c.url) && c.body.email === 'a@b.ly'));
  await h.close();
  // visitor
  h = await launch({ role: 'customer', signedIn: false });
  await h.open('#/apps'); await h.page.waitForSelector('form[data-form="interest"]', { timeout: 8000 });
  check('visitor: sees coming soon + form', true);
  await h.close();
  // super admin
  let built;
  h = await launch({ role: 'super_admin', viewport: { width: 1000, height: 900 }, tables: { websites: [], interest_signups: [{ id: 'i1', email: 'x@y.ly', service: 'apps', created_at: new Date().toISOString() }], website_versions: [] }, rpc: { slug_available: true, request_publish: 'd1' },
    functions: { 'ai-gateway': (b) => { built = b; return { ok: true, model: 'm' }; }, 'verify-publish': { ok: true, url: 'https://myapp.ibtkar.ly' } } });
  await h.open('#/admin/apps'); await h.page.waitForSelector('form[data-form="newapp"]', { timeout: 8000 });
  check('super: interest list shown', (await h.page.locator('text=x@y.ly').count()) > 0);
  await h.page.fill('#sl', 'myapp'); await h.page.fill('input[name=name]', 'حجوزات'); await h.page.fill('textarea[name=desc]', 'تطبيق حجز');
  await h.page.click('form[data-form="newapp"] button.btn.p.lg');
  await h.page.waitForSelector('#bo.ok', { timeout: 15000 });
  const ins = h.calls.find((c) => c.method === 'POST' && /\/websites/.test(c.url));
  check('super: app row created (site_type=app)', ins && ins.body.site_type === 'app' && ins.body.slug === 'myapp');
  check('super: AI build requested', built && built.action === 'build');
  const saved = h.calls.find((c) => c.method === 'POST' && /website_versions/.test(c.url));
  check('super: fallback PWA saved first', saved && /nav/.test(saved.body.snapshot.html) && /data-t="2"/.test(saved.body.snapshot.html));
  check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
  await h.close();
  process.exit(fails ? 2 : 0);
})();
