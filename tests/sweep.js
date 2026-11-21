"use strict";
// Visits every route as customer / super admin / visitor and fails on JS errors, stuck skeletons or the retry card.
const { launch, UID } = require('./mock');
const fs = require('fs');
const out = process.argv[2];
const site = { id: 's1', owner_id: UID, name: 'ملكي', slug: 'royal', site_type: 'store', status: 'published', url: 'https://royal.ibtkar.ly', created_at: new Date().toISOString(), config: {} };
const plans = [{ id: 'p1', code: 'free', name_ar: 'مجانية', name_en: 'Free', price: 0, websites_limit: 1, storage_mb: 100, ai_requests_limit: 50, active: true, sort: 1 }];
const ROUTES = {
  customer: ['#/app', '#/app/sites', '#/app/new', '#/app/apps', '#/app/analytics', '#/app/requests', '#/app/support', '#/app/notes', '#/app/billing', '#/app/contracts', '#/app/settings',
    '#/app/site/s1/overview', '#/app/site/s1/items', '#/app/site/s1/details', '#/app/site/s1/analytics', '#/app/site/s1/versions', '#/app/site/s1/requests', '#/app/site/s1/domains'],
  super_admin: ['#/admin', '#/admin/analytics', '#/admin/users', '#/admin/sites', '#/admin/apps', '#/admin/requests', '#/admin/tickets', '#/admin/invoices', '#/admin/contracts', '#/admin/banners', '#/admin/plans', '#/admin/servers', '#/admin/monitor', '#/admin/engine', '#/admin/prompts', '#/admin/settings', '#/admin/audit'],
  visitor: ['#/', '#/pricing', '#/apps', '#/login', '#/signup', '#/forgot', '#/help'],
};
const MODES = [
  ['light-ar-m', { dark: false, lang: 'ar', viewport: { width: 390, height: 844 } }],
  ['dark-ar-m', { dark: true, lang: 'ar', viewport: { width: 390, height: 844 } }],
  ['light-en-m', { dark: false, lang: 'en', viewport: { width: 390, height: 844 } }],
  ['dark-en-m', { dark: true, lang: 'en', viewport: { width: 390, height: 844 } }],
  ['light-ar-d', { dark: false, lang: 'ar', viewport: { width: 1280, height: 800 } }],
  ['dark-en-d', { dark: true, lang: 'en', viewport: { width: 1280, height: 800 } }],
];
(async () => {
  let fails = 0;
  for (const [mode, mopts] of MODES)
  for (const [role, routes] of Object.entries(ROUTES)) {
    const h = await launch({ role: role === 'visitor' ? 'customer' : role, signedIn: role !== 'visitor', ...mopts, tables: { websites: [site], plans } });
    for (const r of routes) {
      h.errors.length = 0;
      await h.open(r);
      await h.page.waitForTimeout(900);
      const st = await h.page.evaluate(() => ({ sk: !!document.querySelector('#v .sk'), retry: !!document.querySelector('[data-act="retry"]'), len: document.querySelector('#v').innerText.length, hscroll: document.documentElement.scrollWidth - window.innerWidth, dir: document.documentElement.dir, dark: document.body.classList.contains('dark'), arabic: /[\u0600-\u06FF]/.test(document.querySelector('#v').innerText) }));
      const en = mode.includes('-en-'), wantDark = mode.startsWith('dark');
      const bad = h.errors.length || st.sk || st.retry || st.len < 8 || st.hscroll > 2 || st.dark !== wantDark || (en && st.dir !== 'ltr') || (!en && st.dir !== 'rtl');
      if (bad) fails++;
      console.log((bad ? 'FAIL ' : 'ok   ') + mode + ' ' + role + ' ' + r + (bad ? ' ' + JSON.stringify(st) + ' ' + h.errors.join('|').slice(0, 160) : ''));
      if (out) { fs.mkdirSync(out, { recursive: true }); await h.page.screenshot({ path: `${out}/sw-${mode}-${role}-${r.replace(/[^a-z0-9]+/gi, '_')}.png` }); }
    }
    await h.close();
  }
  process.exit(fails ? 2 : 0);
})();
