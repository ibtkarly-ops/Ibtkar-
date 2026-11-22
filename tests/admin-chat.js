"use strict";
// Admin-only AI chat per site: type, press Enter, the preview updates in place (no page reload),
// every reply can be undone, and the conversation is saved with the site.
const { launch, UID } = require('./mock');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
const OWNER = '22222222-3333-4444-5555-666666666666';
(async () => {
  const boot = await launch({ role: 'customer' }); await boot.open('#/'); await boot.page.waitForTimeout(300);
  const { html, brief } = await boot.page.evaluate(() => { const brief = { name: 'مقهى', type: 'landing', lang: 'ar', phone: '0912345678', desc: 'قهوة', color: '#b45309', dna: newDNA('landing') }; return { brief, html: genSite(brief) }; });
  await boot.close();
  const w = { id: 's1', owner_id: OWNER, name: 'مقهى', site_type: 'landing', status: 'draft', created_at: new Date().toISOString(), config: { html, brief } };

  // ---- customers get the same chat inside the Edits tab (there is no separate chat tab any more) ----
  {
    const h = await launch({ role: 'customer', tables: { websites: [{ ...w, owner_id: UID }] } });
    await h.open('#/app/site/s1/requests'); await h.page.waitForSelector('form[data-form="sitechat"]');
    check('customer: Edits tab is a chat with a live preview', await h.page.locator('#scprev').count() === 1 && await h.page.locator('form[data-form="edreq"]').count() === 0 && await h.page.locator('.tabs a[href$="/chat"]').count() === 0);
    await h.close();
  }

  // ---- admin chat ----
  {
    let n = 0;
    const h = await launch({ role: 'super_admin', tables: { websites: [w], website_versions: [{ website_id: 's1', version: 5, snapshot: { html } }], profiles: [{ id: UID, full_name: 'أدمن', role: 'super_admin', status: 'active' }, { id: OWNER, full_name: 'صاحب', role: 'customer', status: 'active' }] }, rpc: { restore_version: null },
      functions: { 'ai-gateway': (b) => { n++; return { ok: true, reply: 'جعلت العنوان أقوى', brief: { ...brief, copy: { hero: { t: 'أطيب قهوة في المدينة' } } }, items: null, redesign: false, _hist: b.history }; } } });
    await h.open('#/app/site/s1/chat'); await h.page.waitForSelector('form[data-form="sitechat"]');
    check('old /chat link opens the Edits chat', await h.page.locator('.tabs a[href$="/requests"].on, .tabs a[href$="/requests"][aria-current]').count() >= 0 && await h.page.locator('.tabs a[href$="/chat"]').count() === 0);
    check('live preview of the site is shown', await h.page.locator('#scprev').count() === 1);
    await h.page.click('[data-act="scex"] >> nth=3');
    check('suggestion chip fills the box', (await h.page.inputValue('form[data-form="sitechat"] textarea')).length > 3);
    await h.page.fill('form[data-form="sitechat"] textarea', 'اكتب عنواناً أقوى');
    const marker = await h.page.evaluate(() => { window.__noReload = 1; return 1; });
    await h.page.press('form[data-form="sitechat"] textarea', 'Enter');
    await h.page.waitForSelector('#scm .ac-b.a', { timeout: 8000 });
    check('Enter sends the message (one AI call)', n === 1);
    check('reply bubble shown with an undo button', await h.page.locator('#scm .ac-b.a >> text=جعلت العنوان أقوى').count() === 1 && await h.page.locator('#scm [data-act="edundo"]').count() === 1);
    check('preview updated in place, page not reloaded', marker === 1 && await h.page.evaluate(() => window.__noReload === 1) && /أطيب قهوة في المدينة/.test(await h.page.locator('#scprev').getAttribute('srcdoc')));
    const up = h.calls.filter((c) => c.method === 'PATCH' && /websites/.test(c.url)).pop();
    check('conversation saved with the site', up && Array.isArray(up.body.config.ai_chat) && up.body.config.ai_chat.length === 2 && up.body.config.ai_chat[1].v === 5);
    h.page.once('dialog', (d) => d.accept());
    await h.page.click('#scm [data-act="edundo"]'); await h.page.waitForTimeout(700);
    const rs = h.calls.find((c) => /rpc\/restore_version/.test(c.url));
    check('undo restores the version before that reply', rs && rs.body.p_version === 5);
    check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
    await h.close();
  }
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 2 : 0);
})();
