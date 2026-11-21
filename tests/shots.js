"use strict";
// Screenshots of the main screens (mobile 390 / desktop 1280, light / dark).  node tests/shots.js <outdir>
const { launch } = require('./mock');
const fs = require('fs');
const out = process.argv[2] || '/tmp/shots';
fs.mkdirSync(out, { recursive: true });
const plans = [
  { id: 'p1', code: 'free', name_ar: 'مجانية', name_en: 'Free', price: 0, websites_limit: 1, ai_requests_limit: 50, storage_mb: 500, active: true, sort: 1, features: [] },
  { id: 'p2', code: 'web', name_ar: 'احترافية', name_en: 'Pro', price: 30, websites_limit: 5, ai_requests_limit: 500, storage_mb: 2000, active: true, sort: 2, features: [] },
  { id: 'p3', code: 'business', name_ar: 'أعمال', name_en: 'Business', price: 90, websites_limit: 20, ai_requests_limit: 3000, storage_mb: 10000, active: true, sort: 3, features: [] },
];
const sites = [{ id: 's1', owner_id: '11111111-2222-3333-4444-555555555555', name: 'ملكي', slug: 'royal', site_type: 'company', status: 'published', created_at: new Date().toISOString(), config: {} }];
const shots = [
  ['home', '', 'customer', false], ['home', '', 'customer', true],
  ['dash', '#/app', 'customer', false], ['dash', '#/app', 'customer', true],
  ['admin', '#/admin', 'super_admin', false], ['engine', '#/admin/engine', 'super_admin', false],
  ['sites', '#/app/sites', 'customer', false], ['new', '#/app/new', 'customer', false],
];
(async () => {
  for (const [w, vp] of [['m', { width: 390, height: 844 }], ['d', { width: 1280, height: 800 }]]) {
    for (const [name, hash, role, dark] of shots) {
      const signedIn = name !== 'home';
      const h = await launch({ role, dark, signedIn, viewport: vp, tables: { plans, websites: sites } });
      await h.open(hash || '#/');
      await h.page.waitForTimeout(1200);
      await h.page.screenshot({ path: `${out}/${w}-${name}${dark ? '-dark' : ''}.png`, fullPage: name === 'home' });
      if (w === 'm' && name === 'dash' && !dark) {
        await h.page.click('.tb .menu-btn'); await h.page.waitForTimeout(400);
        await h.page.screenshot({ path: `${out}/m-drawer.png` });
      }
      if (h.errors.length) console.log(w, name, h.errors);
      await h.close();
    }
  }
  console.log('done');
})();
