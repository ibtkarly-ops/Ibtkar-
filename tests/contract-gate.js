"use strict";
// Publishing is gated on a signed contract: a brand-new site cannot publish until the admin
// sends a contract and the customer signs it; an already-published site is never blocked.
const { launch, UID } = require('./mock');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
const html = '<html><body>' + 'x'.repeat(40) + '</body></html>';
(async () => {
  // ---- 1) vSite: draft site, contract not cleared -> Publish disabled + explained, note shown ----
  {
    const w = { id: 's1', owner_id: UID, name: 'ملكي', site_type: 'company', status: 'draft', created_at: new Date().toISOString(), config: { html } };
    const h = await launch({ role: 'customer', tables: { websites: [w], platform_settings: [{ key: 'public.sites_base_url', value: 'https://x.pages.dev' }] }, rpc: { site_is_contract_cleared: false } });
    await h.open('#/app/site/s1/overview'); await h.page.waitForSelector('[data-act="publish"]');
    const btn = h.page.locator('[data-act="publish"]');
    check('publish button disabled while contract is not cleared', await btn.isDisabled());
    check('tooltip explains why', /عقد/.test(await btn.getAttribute('title')));
    check('pending-contract note shown on the overview tab', await h.page.locator('text=لن يُنشر قبل أن تراجع العقد وتوقّعه').count() === 1);
    await h.close();
  }
  // ---- 2) vSite: draft site, contract cleared -> Publish enabled, no note ----
  {
    const w = { id: 's1', owner_id: UID, name: 'ملكي', site_type: 'company', status: 'draft', created_at: new Date().toISOString(), config: { html } };
    const h = await launch({ role: 'customer', tables: { websites: [w], platform_settings: [{ key: 'public.sites_base_url', value: 'https://x.pages.dev' }] }, rpc: { site_is_contract_cleared: true } });
    await h.open('#/app/site/s1/overview'); await h.page.waitForSelector('[data-act="publish"]');
    check('publish button enabled once the contract is signed', !(await h.page.locator('[data-act="publish"]').isDisabled()));
    check('no pending-contract note', await h.page.locator('text=لن يُنشر قبل أن تراجع العقد وتوقّعه').count() === 0);
    await h.close();
  }
  // ---- 3) vSite: already published -> never gated, regardless of contract status ----
  {
    const w = { id: 's1', owner_id: UID, name: 'ملكي', site_type: 'company', status: 'published', url: 'https://x.pages.dev/royal', created_at: new Date().toISOString(), config: { html } };
    const h = await launch({ role: 'customer', tables: { websites: [w], platform_settings: [{ key: 'public.sites_base_url', value: 'https://x.pages.dev' }] }, rpc: { site_is_contract_cleared: false } });
    await h.open('#/app/site/s1/overview'); await h.page.waitForSelector('[data-act="publish"]');
    check('already-published site: publish stays enabled even if the RPC says not cleared', !(await h.page.locator('[data-act="publish"]').isDisabled()));
    check('already-published site: no pending-contract note', await h.page.locator('text=لن يُنشر قبل أن تراجع العقد وتوقّعه').count() === 0);
    await h.close();
  }
  // ---- 4) a direct publish click surfaces the friendly message when the server rejects with contract_pending ----
  {
    const w = { id: 's1', owner_id: UID, name: 'ملكي', site_type: 'company', status: 'draft', created_at: new Date().toISOString(), config: { html } };
    const h = await launch({ role: 'customer', tables: { websites: [w], platform_settings: [{ key: 'public.sites_base_url', value: 'https://x.pages.dev' }] }, rpc: { site_is_contract_cleared: true, request_publish: { __status: 400, __body: { message: 'contract_pending' } } } });
    await h.open('#/app/site/s1/overview'); await h.page.waitForSelector('[data-act="publish"]');
    await h.page.click('[data-act="publish"]'); await h.page.waitForTimeout(400);
    check('generic publish click explains the contract is pending (not a raw error code)', await h.page.locator('text=لا يمكن نشر الموقع حالياً. يجب على العميل مراجعة العقد وتوقيعه أولاً.').count() > 0);
    await h.close();
  }
  // ---- 5) wizard end-to-end: brand-new site build succeeds but publish is gated ----
  {
    const h = await launch({
      role: 'customer', viewport: { width: 390, height: 844 },
      rpc: { slug_available: true, request_publish: { __status: 400, __body: { message: 'contract_pending' } }, issue_contract_for_site: { ok: true } },
      functions: { 'ai-gateway': { ok: false, error: 'service_not_configured' } },
      tables: { websites: [], website_versions: [] },
    });
    const { page } = h;
    await h.open('#/app/new/form'); await page.waitForSelector('form[data-form="wizard"]');
    const next = async () => { await page.click('[data-act="wznext"]'); await page.waitForTimeout(120); };
    await page.fill('textarea[name=desc]', 'شركة استشارات'); await page.click('.tc:nth-child(2)'); await next();
    await page.fill('input[name=name]', 'شركتي'); await page.fill('#sl', 'mycoxx'); await page.waitForTimeout(700); await next();
    await page.fill('input[name=phone]', '0912345678'); await next(); await next(); await next(); await next();
    await page.click('#wzgo'); await page.waitForSelector('#bo.ok, #bo.err', { timeout: 15000 });
    check('wizard shows the friendly "ready, awaiting contract" card', await page.locator('text=موقعك جاهز!').count() === 1);
    check('wizard message points the customer to "My contracts"', await page.locator('text=صفحة «عقودي»').count() === 1);
    check('no "send/publish" retry button offered on this card (only manage)', await page.locator('[data-act="bopublish"]').count() === 0 && await page.locator('[data-act="boview"]').count() === 1);
    check('the contract is issued automatically (idempotent RPC) once the site is ready', h.calls.some((c) => /rpc\/issue_contract_for_site/.test(c.url)));
    check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
    await h.close();
  }
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 2 : 0);
})();
