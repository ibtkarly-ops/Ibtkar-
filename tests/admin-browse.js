"use strict";
// Admin (super_admin/admin) opens a customer's site directly from their own admin account —
// same vSite() page/tabs the customer uses, no "log in as the customer" needed. Only requirement:
// a clear "browsing as admin" banner so it's never mistaken for the admin's own account, and saving
// (items tab) must actually work from the admin session.
const { launch, UID } = require('./mock');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
const CUSTOMER_ID = '22222222-3333-4444-5555-666666666666';
(async () => {
  const boot = await launch({ role: 'customer' }); await boot.open('#/'); await boot.page.waitForTimeout(300);
  const html = await boot.page.evaluate(() => genSite({ name: 'متجر العميل', type: 'store', lang: 'ar', phone: '0912345678', desc: 'متجر' }));
  await boot.close();
  const w = { id: 's1', owner_id: CUSTOMER_ID, name: 'متجر العميل', slug: 'customer-shop', site_type: 'store', status: 'published', url: 'https://customer-shop.ibtkar.ly', created_at: new Date().toISOString(), config: { html } };
  const customerProfile = { id: CUSTOMER_ID, full_name: 'سالم العميل', role: 'customer', lang: 'ar', status: 'active', created_at: new Date().toISOString() };

  // ---- super_admin opens the customer's site directly: banner shown, backed by the real owner's name ----
  {
    const h = await launch({
      role: 'super_admin',
      tables: { websites: [w], profiles: [{ id: UID, full_name: 'ايوب رضاء', role: 'super_admin', lang: 'ar', status: 'active', created_at: new Date().toISOString() }, customerProfile], website_versions: [], platform_settings: [{ key: 'public.sites_root_domain', value: 'ibtkar.ly' }] },
      rpc: { request_publish: 'dep-1' },
      functions: { 'verify-publish': { ok: true, url: 'https://customer-shop.ibtkar.ly' } },
    });
    await h.open('#/app/site/s1/items'); await h.page.waitForSelector('form[data-form="items"]', { timeout: 8000 });
    check('admin-browsing banner shown', await h.page.locator('text=تتصفّح موقع').count() === 1);
    check('banner names the real owner', await h.page.locator('text=سالم العميل').count() === 1);
    check('banner links back to all sites', await h.page.locator('a[href="#/admin/sites"]').count() >= 1);
    // save an item edit from the admin session — must actually persist, same as the customer's own save would
    await h.page.locator('.irow').first().locator('[data-k=n]').fill('منتج عدّله الأدمن');
    await h.page.click('form[data-form="items"] button.btn.p');
    await h.page.waitForTimeout(800);
    const saved = h.calls.find((c) => c.method === 'POST' && /website_versions/.test(c.url));
    check('save from the admin session actually persists a new version', !!saved);
    check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
    await h.close();
  }

  // ---- the customer opens their own site: no banner (it is their own account, not someone else's) ----
  {
    const h = await launch({ role: 'customer', tables: { websites: [{ ...w, owner_id: UID }], platform_settings: [{ key: 'public.sites_root_domain', value: 'ibtkar.ly' }] } });
    await h.open('#/app/site/s1/items'); await h.page.waitForSelector('form[data-form="items"]', { timeout: 8000 });
    check('no admin banner on the owner\'s own site', await h.page.locator('text=تتصفّح موقع').count() === 0);
    await h.close();
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 2 : 0);
})();
