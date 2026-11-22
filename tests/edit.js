"use strict";
// Instant AI edits: the customer describes a change, the AI returns a small patch, the page engine re-renders it,
// a version is saved (undo) and a published site is re-published. No quote, no approval step.
const { launch, UID } = require('./mock');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
(async () => {
  const boot = await launch({ role: 'customer' }); await boot.open('#/'); await boot.page.waitForTimeout(300);
  const { html, brief } = await boot.page.evaluate(() => { const brief = { name: 'ملكي', type: 'landing', lang: 'ar', phone: '0912345678', wa: '0912345678', desc: 'وصف', color: '#2433ff', dna: newDNA('landing') }; return { brief, html: genSite(brief) }; });
  await boot.close();
  const site = () => ({ id: 's1', owner_id: UID, name: 'ملكي', slug: 'royal', site_type: 'landing', status: 'published', url: 'https://x.pages.dev/royal', created_at: new Date().toISOString(), config: { html, brief } });
  const tables = () => ({ websites: [site()], website_versions: [{ website_id: 's1', version: 3, snapshot: { html }, note: 'initial' }], platform_settings: [{ key: 'public.sites_base_url', value: 'https://x.pages.dev' }],
    modification_requests: [{ id: 'old', website_id: 's1', description: 'أضف رقم الهاتف', status: 'submitted', created_at: new Date().toISOString() }] });

  // ---- success: edit applied, version saved with the brief, re-published, result + undo shown ----
  {
    let sent = null;
    const h = await launch({ role: 'customer', tables: tables(), rpc: { request_publish: 'dep-1', restore_version: null },
      functions: { 'ai-gateway': (b) => { sent = b; return { ok: true, reply: 'غيّرت اللون للأحمر', brief: { ...brief, color: '#ff0000', copy: { hero: { t: 'عنوان جديد' } } }, items: null, redesign: false }; }, 'verify-publish': { ok: true, url: 'https://x.pages.dev/royal' } } });
    await h.open('#/app/site/s1/requests'); await h.page.waitForSelector('form[data-form="edreq"]');
    check('no price / approval buttons anymore', await h.page.locator('[data-act="aiquote"],[data-act="aiaccept"],[data-act="aiapply"]').count() === 0);
    check('a stuck old request can be run now', await h.page.locator('[data-act="edrun"]').count() === 1);
    await h.page.fill('form[data-form="edreq"] textarea', 'غيّر اللون للأحمر واكتب عنواناً جديداً');
    await h.page.click('form[data-form="edreq"] button.btn.p');
    await h.page.waitForSelector('text=تم تنفيذ التعديل', { timeout: 8000 });
    check('gateway got action=edit with the instruction and design choices', sent && sent.action === 'edit' && /أحمر/.test(sent.instruction) && Array.isArray(sent.choices.hero));
    const v = h.calls.filter((c) => c.method === 'POST' && /website_versions/.test(c.url)).pop();
    check('new version saved with the edited brief', v && /^edit: /.test(v.body.note) && v.body.snapshot.brief.color === '#ff0000' && /عنوان جديد/.test(v.body.snapshot.html));
    check('the DNA (design) is kept, not re-rolled', v && v.body.snapshot.brief.dna && v.body.snapshot.brief.dna.hero === brief.dna.hero);
    check('published site re-published automatically', h.calls.some((c) => /rpc\/request_publish/.test(c.url)));
    check('result card shows the AI reply and an undo button', await h.page.locator('text=غيّرت اللون للأحمر').count() >= 1 && await h.page.locator('[data-act="edundo"]').count() >= 1);
    h.page.once('dialog', (d) => d.accept());
    await h.page.click('[data-act="edundo"]'); await h.page.waitForTimeout(800);
    const rs = h.calls.find((c) => /rpc\/restore_version/.test(c.url));
    check('undo restores the version from before the edit', rs && rs.body.p_site === 's1' && rs.body.p_version === 3);
    check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
    await h.close();
  }

  // ---- "redesign" from the AI re-rolls the DNA ----
  {
    const h = await launch({ role: 'customer', tables: tables(), rpc: { request_publish: 'd' },
      functions: { 'ai-gateway': () => ({ ok: true, reply: 'تصميم جديد', brief, items: null, redesign: true }), 'verify-publish': { ok: true, url: 'u' } } });
    await h.open('#/app/site/s1/requests'); await h.page.waitForSelector('form[data-form="edreq"]');
    let diff = false;
    for (let i = 0; i < 3 && !diff; i++) {
      await h.page.fill('form[data-form="edreq"] textarea', 'صمّم الموقع من جديد');
      await h.page.click('form[data-form="edreq"] button.btn.p'); await h.page.waitForSelector('text=تم تنفيذ التعديل', { timeout: 8000 });
      const v = h.calls.filter((c) => c.method === 'POST' && /website_versions/.test(c.url)).pop();
      diff = JSON.stringify(v.body.snapshot.brief.dna) !== JSON.stringify(brief.dna);
    }
    check('redesign gives the site a new design DNA', diff);
    await h.close();
  }

  // ---- failure (daily limit) shows a clear message and saves nothing ----
  {
    const h = await launch({ role: 'customer', tables: tables(), functions: { 'ai-gateway': () => ({ status: 429, body: { error: 'edits_limit', limit: 20 } }) } });
    await h.open('#/app/site/s1/requests'); await h.page.waitForSelector('form[data-form="edreq"]');
    await h.page.fill('form[data-form="edreq"] textarea', 'أي تعديل');
    await h.page.click('form[data-form="edreq"] button.btn.p'); await h.page.waitForTimeout(900);
    check('limit message shown', await h.page.locator('text=حد التعديلات اليومي').count() >= 1);
    check('nothing saved', !h.calls.some((c) => c.method === 'POST' && /website_versions/.test(c.url)));
    check('the edit button works again', !(await h.page.locator('form[data-form="edreq"] button.btn.p').isDisabled()));
    await h.close();
  }
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 2 : 0);
})();
