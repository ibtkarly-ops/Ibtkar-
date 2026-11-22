"use strict";
// Contracts: a system template (preview, send), the public signing page (draw-only, no blank signature, agree box,
// signed copy + print), and the admin list actions (relink site, void, delete draft, approve).
const { launch, UID } = require('./mock');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
const TOKEN = '61066f39-8c51-4649-be21-c4d52ca562a6';
const now = new Date().toISOString();
const BODY = '## الأطراف\n\nالطرف الأول: ابتكار.\nالطرف الثاني: عميل.\n\n## القيمة والدفع\n\nقيمة الاشتراك 19 $ شهرياً.';
(async () => {
  // ---------- public signing page ----------
  {
    let signed = null; const posts = [];
    const meta = () => ({ contract: signed ? { status: 'received_signed', contract_number: 'IBT-2026-0007', title: 'عقد اتفاق خدمات', kind: 'template', body: BODY, has_esign: true, esign_name: 'أيوب', esign_at: now, esign_url: 'https://x.supabase.co/sig.png' } : { status: 'sent', contract_number: 'IBT-2026-0007', title: 'عقد اتفاق خدمات', kind: 'template', body: BODY, has_original: false } });
    const h = await launch({ role: 'customer', signedIn: false, viewport: { width: 390, height: 844 },
      functions: { 'contract-file': (b, url) => { if (b && b.which === 'esign') { posts.push(b); signed = b; return { ok: true }; } return meta(); } } });
    const { page } = h;
    await h.open('#/c/' + TOKEN); await page.waitForSelector('#esigncv', { timeout: 8000 });
    check('contract text is shown on the page', /الأطراف/.test(await page.locator('.ctrbody').innerText()) && /19/.test(await page.locator('.ctrbody').innerText()));
    check('draw-only: no "upload a signed copy" form', (await page.locator('form[data-form="csign"], input[type=file]').count()) === 0);
    await page.fill('#esignname', 'أيوب');
    await page.click('[data-act="esignsubmit"]'); await page.waitForTimeout(300);
    check('a blank signature is refused (nothing sent)', posts.length === 0);
    const box = await page.locator('#esigncv').boundingBox();
    await page.mouse.move(box.x + 30, box.y + 60); await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 30 + i * 14, box.y + 60 + (i % 2 ? 30 : -30));
    await page.mouse.up();
    await page.click('[data-act="esignsubmit"]'); await page.waitForTimeout(300);
    check('without ticking "I agree" nothing is sent', posts.length === 0);
    await page.check('#esignagree'); await page.click('[data-act="esignsubmit"]');
    await page.waitForSelector('[data-act="ctrprint"]', { timeout: 8000 });
    check('signature, name and agreement are sent', posts.length === 1 && posts[0].token === TOKEN && posts[0].name === 'أيوب' && posts[0].agree === true && posts[0].image_base64.length > 600);
    check('after signing: signed copy with the signature image, name and print button', (await page.locator('.ctrsig img').getAttribute('src')).includes('sig.png') && /أيوب/.test(await page.locator('.ctrsig').innerText()) && (await page.locator('#esigncv').count()) === 0);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('phone width: no horizontal scroll', sw <= 1);
    check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
    await h.close();
  }
  // a failed request explains itself instead of "not found"
  {
    const h = await launch({ role: 'customer', signedIn: false, functions: { 'contract-file': { status: 500, body: { error: 'x' } } } });
    await h.open('#/c/' + TOKEN); await h.page.waitForSelector('.empty', { timeout: 8000 });
    check('unknown/failed contract shows the not-found message', /العقد|غير/.test(await h.page.locator('.empty').innerText()));
    await h.close();
  }

  // ---------- admin ----------
  const cust = { id: 'c1', full_name: 'عميل تجريبي', role: 'customer', status: 'active' };
  const sites = [{ id: 'w1', name: 'موقع العميل', owner_id: 'c1', status: 'draft', site_type: 'company' }];
  const plans = [{ code: 'web', name_ar: 'ويب', price: 19, active: true, sort: 1 }, { code: 'business', name_ar: 'بزنس', price: 29, active: true, sort: 2 }];
  const ct = (o) => ({ customer_id: 'c1', title: 'عقد اتفاق خدمات', created_at: now, kind: 'template', profiles: { full_name: 'عميل تجريبي' }, websites: null, website_id: null, share_token: TOKEN, ...o });
  const contracts = [ct({ id: 'k1', contract_number: 'IBT-1', status: 'draft' }), ct({ id: 'k2', contract_number: 'IBT-2', status: 'sent' }), ct({ id: 'k3', contract_number: 'IBT-3', status: 'received_signed', esign_image_path: 'esign/k3.png', websites: { name: 'موقع العميل' }, website_id: 'w1' }), ct({ id: 'k4', contract_number: 'IBT-4', status: 'approved', website_id: 'w1', websites: { name: 'موقع العميل' } })];
  {
    const h = await launch({ role: 'super_admin', viewport: { width: 1200, height: 1000 }, tables: { profiles: [{ id: UID, full_name: 'أدمن', role: 'super_admin', status: 'active' }, cust], websites: sites, plans, contracts } });
    const { page } = h;
    await h.open('#/admin/contracts'); await page.waitForSelector('#ctf-tpl', { timeout: 8000 });
    const pv = () => page.locator('#ctpv').innerText();
    check('template preview names the customer, plan and price', /عميل تجريبي/.test(await pv()) && /ويب/.test(await pv()) && /19/.test(await pv()));
    check('missing-site warning is shown', await page.locator('#ctnosite').isVisible());
    await page.selectOption('#ctplan', 'بزنس'); await page.waitForTimeout(150);
    check('choosing a plan fills the price and the preview', (await page.inputValue('#ctprice')) === '29' && /29/.test(await pv()));
    await page.selectOption('#ctrsite', 'w1'); await page.waitForTimeout(150);
    check('choosing a site hides the warning and names it in the text', !(await page.locator('#ctnosite').isVisible()) && /موقع العميل/.test(await pv()));
    await page.fill('textarea[name=extra]', 'بند خاص: دفعة مقدمة'); await page.waitForTimeout(100);
    check('extra clauses appear in the preview', /دفعة مقدمة/.test(await pv()));
    await page.click('button[name=mode][value=send]'); await page.waitForTimeout(600);
    const ins = h.calls.find((c) => c.method === 'POST' && /\/contracts/.test(c.url));
    check('template contract saved with text + terms and NO null title', ins && ins.body.kind === 'template' && /الأطراف/.test(ins.body.body) && ins.body.terms.price === '29' && ins.body.website_id === 'w1' && !('title' in ins.body));
    check('create-and-send marks it sent and notifies the customer', h.calls.some((c) => c.method === 'PATCH' && /\/contracts/.test(c.url) && c.body.status === 'sent') && h.calls.some((c) => c.method === 'POST' && /notifications/.test(c.url) && c.body.type === 'contract_ready'));
    // file mode
    await page.click('[data-act="ctrmode"][data-k="file"]');
    check('custom file form is still available', await page.locator('#ctf-file').isVisible() && !(await page.locator('#ctf-tpl').isVisible()));
    await page.setInputFiles('#ctf-file input[type=file]', { name: 'c.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 ' + 'x'.repeat(300)) });
    await page.click('#ctf-file button.btn.p'); await page.waitForTimeout(700);
    const fi = h.calls.filter((c) => c.method === 'POST' && /rest\/v1\/contracts/.test(c.url)).pop();
    check('file contract with an empty title no longer fails (title omitted)', fi && fi.body.customer_id === 'c1' && !('title' in fi.body));
    // list actions
    check('list: draft can be sent or deleted', await page.locator('[data-act="ctrsend"][data-id="k1"]').count() === 1 && await page.locator('[data-act="ctrdel"][data-id="k1"]').count() === 1);
    check('list: sent has copy link + WhatsApp, void', await page.locator('[data-act="ctrcopy"]').count() >= 1 && await page.locator('[data-act="ctrvoid"][data-id="k2"]').count() === 1);
    check('list: a contract without a site offers relinking (with a warning mark)', await page.locator('select[data-chg="ctrsite"][data-id="k2"]').count() === 1);
    check('list: signed contract can be viewed and approved', await page.locator('[data-act="ctrapprove"][data-id="k3"]').count() === 1 && await page.locator('a[href*="#/c/"]').count() >= 1);
    check('list: an approved contract cannot be voided', await page.locator('[data-act="ctrvoid"][data-id="k4"]').count() === 0);
    await page.selectOption('select[data-chg="ctrsite"][data-id="k2"]', 'w1'); await page.waitForTimeout(400);
    check('relinking sends website_id', h.calls.some((c) => c.method === 'PATCH' && /\/contracts/.test(c.url) && c.body.website_id === 'w1'));
    page.once('dialog', (d) => d.accept()); await page.click('[data-act="ctrvoid"][data-id="k2"]'); await page.waitForTimeout(500);
    check('void marks the contract void', h.calls.some((c) => c.method === 'PATCH' && /\/contracts/.test(c.url) && c.body.status === 'void'));
    page.once('dialog', (d) => d.accept()); await page.click('[data-act="ctrdel"][data-id="k1"]'); await page.waitForTimeout(500);
    check('deleting a draft sends DELETE', h.calls.some((c) => c.method === 'DELETE' && /\/contracts/.test(c.url)));
    check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
    await h.close();
  }
  // admin notification of a signature links to the contracts page
  {
    const h = await launch({ role: 'super_admin', tables: { notifications: [{ id: 'n1', user_id: UID, type: 'contract_signed', title: 'contract_signed', body: 'IBT-2026-0007', created_at: now }] } });
    await h.open('#/app/notes'); await h.page.waitForSelector('a.card[href="#/admin/contracts"]', { timeout: 8000 });
    check('admin gets "customer signed" notification linking to the contracts page', /وقّع العميل العقد/.test(await h.page.locator('a.card[href="#/admin/contracts"]').innerText()));
    await h.close();
  }
  process.exit(fails ? 2 : 0);
})();
