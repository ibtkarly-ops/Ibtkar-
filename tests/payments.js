"use strict";
// Payments (UI): admins record what was received, only the Super Admin approves an amount, the site page explains a payment block.
const { launch, UID } = require('./mock');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
const now = new Date().toISOString();
const tables = (role) => ({
  profiles: [{ id: UID, full_name: 'أدمن', role, status: 'active' }, { id: 'c1', full_name: 'عميل تجريبي', role: 'customer', status: 'active' }],
  websites: [{ id: 'w1', name: 'موقع العميل', owner_id: 'c1', status: 'draft', site_type: 'company' }],
  site_payments: [{ id: 'p1', website_id: 'w1', customer_id: 'c1', amount_received: 500, approved_amount: null, currency: 'LYD', status: 'pending', created_at: now, method: 'cash', reference: 'R1' }, { id: 'p2', website_id: 'w1', customer_id: 'c1', amount_received: 300, approved_amount: 300, currency: 'LYD', status: 'approved', created_at: now }],
  platform_settings: [{ key: 'publish.require_payment', value: 'false' }],
});
(async () => {
  {
    const h = await launch({ role: 'super_admin', viewport: { width: 1200, height: 1000 }, tables: tables('super_admin') });
    const { page } = h; page.on('dialog', (d) => d.accept('450'));
    await h.open('#/admin/payments'); await page.waitForSelector('form[data-form="payrec"]', { timeout: 8000 });
    const txt = await page.locator('#v').innerText();
    check('both payments are listed with received and approved amounts', /500/.test(txt) && /300/.test(txt) && /R1/.test(txt));
    check('approve/reject only on the pending payment', (await page.locator('[data-act="payrev"][data-k="approve"]').count()) === 1);
    await page.selectOption('select[name=site]', 'w1'); await page.fill('input[name=amount]', '250'); await page.fill('input[name=method]', 'bank'); await page.click('form[data-form="payrec"] button'); await page.waitForTimeout(500);
    const rec = h.calls.find((c) => c.url.includes('/rpc/admin_record_payment'));
    check('recording goes through the database function with the received amount only', !!rec && rec.body.p_site === 'w1' && rec.body.p_received === 250 && rec.body.p_method === 'bank' && !('p_approved' in rec.body));
    await h.open('#/admin/payments'); await page.waitForSelector('[data-act="payrev"]');
    await page.click('[data-act="payrev"][data-k="approve"]'); await page.waitForTimeout(500);
    const rev = h.calls.find((c) => c.url.includes('/rpc/admin_review_payment'));
    check('approving sends the chosen approved amount (450 of 500)', !!rev && rev.body.p_action === 'approve' && rev.body.p_amount === 450 && rev.body.p_payment === 'p1');
    await page.click('[data-chg="payreq"]'); await page.waitForTimeout(400);
    const up = h.calls.find((c) => c.method === 'POST' && c.url.includes('platform_settings'));
    check('the payment-required switch is saved as a setting', !!up && JSON.stringify(up.body).includes('publish.require_payment') && JSON.stringify(up.body).includes('true'));
    check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
    await h.close();
  }
  {
    const h = await launch({ role: 'admin', viewport: { width: 1200, height: 1000 }, tables: tables('admin') });
    await h.open('#/admin/payments'); await h.page.waitForSelector('form[data-form="payrec"]', { timeout: 8000 });
    check('a plain admin can record but cannot approve or change the switch', (await h.page.locator('[data-act="payrev"]').count()) === 0 && (await h.page.locator('[data-chg="payreq"]:not([disabled])').count()) === 0);
    await h.close();
  }
  {
    const w = { id: 's1', owner_id: UID, name: 'ملكي', site_type: 'company', status: 'draft', created_at: now, config: { html: '<html><body>' + 'x'.repeat(40) + '</body></html>' } };
    const h = await launch({ role: 'customer', tables: { websites: [w], platform_settings: [{ key: 'public.sites_base_url', value: 'https://x.pages.dev' }] }, rpc: { site_is_contract_cleared: true, site_payment_cleared: false } });
    await h.open('#/app/site/s1/overview'); await h.page.waitForSelector('[data-act="publish"]');
    check('contract cleared but payment not approved: publish disabled and the reason is explained', (await h.page.locator('[data-act="publish"]').isDisabled()) && (await h.page.locator('text=بانتظار اعتماد الدفع').count()) >= 1);
    await h.close();
    const h2 = await launch({ role: 'customer', tables: { websites: [w], platform_settings: [{ key: 'public.sites_base_url', value: 'https://x.pages.dev' }] }, rpc: { site_is_contract_cleared: true, site_payment_cleared: true } });
    await h2.open('#/app/site/s1/overview'); await h2.page.waitForSelector('[data-act="publish"]');
    check('everything cleared: publish enabled', !(await h2.page.locator('[data-act="publish"]').isDisabled()));
    await h2.close();
  }
  console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
})();
