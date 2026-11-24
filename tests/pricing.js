"use strict";
// Admin pricing page: official rules are editable, quotes need an explicit Super Admin approval, complex projects ask for the final price.
const { launch, UID } = require('./mock');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
(async () => {
  const now = new Date().toISOString();
  const rules = [
    { code: 'custom', name_ar: 'مشروع مخصص', ibtkar_fee: 200, ai_fee: 400, ai_fee_is_minimum: false, needs_review: false, active: true, sort: 1 },
    { code: 'template', name_ar: 'مشروع بسيط على قالب', ibtkar_fee: 100, ai_fee: 100, ai_fee_is_minimum: false, needs_review: false, active: true, sort: 2 },
    { code: 'simple_custom', name_ar: 'مشروع بسيط بتخصيص أكبر', ibtkar_fee: 100, ai_fee: 150, ai_fee_is_minimum: true, needs_review: false, active: true, sort: 3 },
    { code: 'complex', name_ar: 'مشروع متوسط أو معقد', ibtkar_fee: 0, ai_fee: 0, ai_fee_is_minimum: false, needs_review: true, active: true, sort: 4 },
  ];
  const quotes = [
    { id: 'q1', website_id: 'w1', customer_id: 'c1', rule_code: 'custom', ibtkar_fee: 200, ai_fee: 400, status: 'proposed', created_at: now, websites: { name: 'موقع أ' }, profiles: { full_name: 'عميل' } },
    { id: 'q2', website_id: 'w1', customer_id: 'c1', rule_code: 'complex', ibtkar_fee: 0, ai_fee: 0, suggested_total: 345, status: 'proposed', created_at: now, websites: { name: 'موقع أ' }, profiles: { full_name: 'عميل' } },
  ];
  const h = await launch({ role: 'super_admin', viewport: { width: 1200, height: 1000 }, tables: { pricing_rules: rules, pricing_weights: [{ factor: 'pages', label_ar: 'كل صفحة', unit_price: 15, sort: 1 }], external_services: [{ id: 's1', code: 'vps', name_ar: 'سيرفر VPS', billing: 'monthly', price: 25 }], project_quotes: quotes, pricing_rule_history: [], websites: [{ id: 'w1', name: 'موقع أ', owner_id: 'c1', status: 'draft', site_type: 'company' }], profiles: [{ id: UID, full_name: 'أدمن', role: 'super_admin', status: 'active' }] },
    rpc: { approve_quote: () => null, create_quote: () => 'q3' } });
  const { page } = h;
  await h.open('#/admin/pricing'); await page.waitForSelector('form[data-form="pricerule"]', { timeout: 8000 });
  const txt = await page.locator('main, body').first().innerText();
  check('the four official rules are listed with their totals (600 / 200 / 250)', /600\.00/.test(txt) && /200\.00/.test(txt) && /250\.00/.test(txt));
  check('external services are shown separately with their billing period', /سيرفر VPS/.test(txt) && /شهري/.test(txt));
  await page.fill('form[data-code="template"] input[name=ai]', '120'); await page.click('form[data-code="template"] button'); await page.waitForTimeout(400);
  check('saving a rule updates pricing_rules', h.calls.some((c) => c.method === 'PATCH' && /pricing_rules/.test(c.url) && c.body.ai_fee === 120 && c.body.ibtkar_fee === 100));
  page.once('dialog', (d) => d.accept()); await page.click('[data-act="quoteapprove"][data-id="q1"]'); await page.waitForTimeout(400);
  check('a fixed-price quote is approved only after confirmation, through the RPC', h.calls.some((c) => /rpc\/approve_quote/.test(c.url) && c.body.p_id === 'q1' && c.body.p_ibtkar === null));
  const ans = ['300', '150']; page.on('dialog', (d) => d.accept(ans.shift() || ''));
  await page.click('[data-act="quoteapprove"][data-id="q2"]'); await page.waitForTimeout(500);
  check('a complex project asks the admin for the final fees (suggestion is not applied automatically)', h.calls.some((c) => /rpc\/approve_quote/.test(c.url) && c.body.p_id === 'q2' && c.body.p_ibtkar === 300 && c.body.p_ai === 150));
  await page.selectOption('form[data-form="quotenew"] select[name=rule]', 'complex'); await page.fill('form[data-form="quotenew"] input[name=pages]', '8'); await page.click('form[data-form="quotenew"] button'); await page.waitForTimeout(400);
  check('new quote sends the scoring inputs to create_quote', h.calls.some((c) => /rpc\/create_quote/.test(c.url) && c.body.p_rule === 'complex' && c.body.p_inputs.pages === 8));
  check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
  await h.close();
  process.exit(fails ? 2 : 0);
})();
