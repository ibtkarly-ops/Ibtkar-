"use strict";
// App builder (Mobtakir-style): "coming soon" for customers who are not enabled; super admin and enabled users get
// chat -> plan card -> "Start building" (file by file) -> Expo Go QR -> files + ZIP -> store builds (super admin only).
const { launch, UID } = require('./mock');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
const PLAN = { name: 'عيادتي', summary: 'حجز مواعيد', icon: '🦷', screens: [{ name: 'الرئيسية', purpose: 'المواعيد' }, { name: 'الحجز', purpose: 'حجز' }], colors: { primary: '#0f766e', background: '#ffffff', text: '#111827' }, features: ['حجز موعد', 'تذكير'], files: [{ path: 'App.js', purpose: 'تنقل' }, { path: 'src/theme.js', purpose: 'ألوان' }, { path: 'src/screens/HomeScreen.js', purpose: 'الرئيسية' }] };
const CODE = (p) => `// ${p}\nimport React from 'react';\nexport default function X() { return null; }`;
const now = new Date().toISOString();
(async () => {
  // customer without access
  let h = await launch({ role: 'customer', viewport: { width: 1000, height: 800 } });
  await h.open('#/app/apps'); await h.page.waitForSelector('form[data-form="interest"]', { timeout: 8000 });
  check('customer: menu has Apps row', (await h.page.locator('#drawer .dr-i[href="#/app/apps"].on').count()) === 1);
  check('customer: coming soon with the mobile-app text, no builder', (await h.page.locator('text=قريباً').count()) > 0 && (await h.page.locator('text=Expo Go').count()) > 0 && (await h.page.locator('[data-act="newapp"]').count()) === 0);
  await h.page.fill('form[data-form="interest"] input[name=email]', 'a@b.ly'); await h.page.click('form[data-form="interest"] button');
  await h.page.waitForTimeout(300);
  check('customer: interest saved', h.calls.some((c) => c.method === 'POST' && /interest_signups/.test(c.url) && c.body.email === 'a@b.ly'));
  await h.close();

  // visitor: home section + public apps page
  h = await launch({ role: 'customer', signedIn: false, viewport: { width: 1200, height: 900 } });
  await h.open('#/'); await h.page.waitForSelector('.lp-app', { timeout: 8000 });
  check('home: "your idea becomes an app" section with 3 steps and a phone', (await h.page.locator('.lp-app .lp-apst li').count()) === 3 && (await h.page.locator('.lp-app .lp-phone').count()) === 1);
  await h.open('#/apps'); await h.page.waitForSelector('form[data-form="interest"]', { timeout: 8000 });
  check('visitor: coming soon + form', true);
  await h.close();

  // customer the super admin enabled: gets the builder, no store-build buttons
  const mine = { id: 'app2', owner_id: UID, name: 'عيادتي', site_type: 'app', created_at: now, updated_at: now, config: { app: { rev: 1, plan: PLAN, files: { 'App.js': CODE('App.js') }, chat: [] } } };
  h = await launch({ role: 'customer', viewport: { width: 1100, height: 900 }, tables: { profiles: [{ id: UID, full_name: 'عميل', role: 'customer', status: 'active', apps_access: true }], websites: [mine] } });
  await h.open('#/app/apps'); await h.page.waitForSelector('[data-act="newapp"]', { timeout: 8000 });
  check('enabled customer: builder list with built app card', (await h.page.locator('a.apcard[href="#/app/apps/app2"]').count()) === 1 && (await h.page.locator('.ap-how div').count()) === 3);
  await h.open('#/app/apps/app2'); await h.page.waitForSelector('[data-act="aptab"]');
  await h.page.click('[data-act="aptab"][data-k="build"]'); await h.page.waitForSelector('.apbuild');
  check('enabled customer: no store-build buttons (team starts them)', (await h.page.locator('[data-act="apeas"]').count()) === 0);
  await h.close();

  // super admin: full flow
  const app = { id: 'app1', owner_id: UID, name: 'تطبيق جديد', site_type: 'app', status: 'draft', created_at: now, config: { app: { chat: [] } } };
  const sent = [];
  h = await launch({ role: 'super_admin', viewport: { width: 1200, height: 900 }, tables: { websites: [app], interest_signups: [{ id: 'i1', email: 'x@y.ly', service: 'apps', created_at: now }] },
    functions: { 'ai-gateway': (b) => {
      sent.push(b);
      if (b.action === 'app_chat') return { ok: true, type: 'plan', content: 'هذه خطة تطبيقك', plan: PLAN, model: 'm', delayMs: 300 };
      if (b.action === 'app_file') return { ok: true, path: b.path, code: CODE(b.path) };
      if (b.action === 'app_commit') { app.config.app = { ...app.config.app, rev: 1, plan: PLAN, slug: 'clinic-app1', files: { ...b.files, 'app.json': '{}', 'package.json': '{}' }, chat: [{ role: 'user', content: 'x' }, { role: 'assistant', type: 'built', content: b.note, rev: 1 }] }; return { ok: true, rev: 1 }; }
      if (b.action === 'app_snack') return { ok: true, url: 'https://snack.expo.dev/?platform=mydevice&files=%7B%7D', go: 'https://ppegbmqkcdwopakewetl.supabase.co/functions/v1/app-export?go=app1&k=abc', rev: 1 };
      if (b.action === 'app_build') return { ok: false, error: 'build_not_configured' };
      return { ok: false, error: 'x' };
    } } });
  const { page } = h;
  await h.open('#/admin/apps'); await page.waitForSelector('[data-act="newapp"]', { timeout: 8000 });
  check('super: apps list + interest list', (await page.locator('a.apcard[href="#/admin/apps/app1"]').count()) === 1 && (await page.locator('text=x@y.ly').count()) > 0);
  await h.open('#/admin/apps/app1'); await page.waitForSelector('form[data-form="appmsg"]');
  check('chat starts with examples; Expo tab says nothing built yet', (await page.locator('.ac-hello .chip').count()) === 4 && (await page.locator('[data-act="apexpo"]').count()) === 0);
  await page.click('.ac-hello .chip'); check('example fills the message box', (await page.locator('textarea[name=m]').inputValue()).length > 5);
  await page.click('form[data-form="appmsg"] button');
  await page.waitForSelector('.applan [data-act="apbuild"]', { timeout: 6000 });
  const chat = sent.find((b) => b.action === 'app_chat');
  check('message sent to app_chat with the website id', chat && chat.website_id === 'app1' && chat.message.length > 5);
  check('plan card: name, screens, colours, file count', (await page.locator('.applan .pl-h b', { hasText: 'عيادتي' }).count()) === 1 && (await page.locator('.applan .pl-s .chip').count()) === 2 && (await page.locator('.applan .pl-c i').count()) === 3);
  await page.click('.applan [data-act="apbuild"]');
  await page.waitForSelector('[data-act="apexpo"]', { timeout: 8000 });
  const fl = sent.filter((b) => b.action === 'app_file');
  check('built file by file, then committed', fl.map((b) => b.path).join(',') === 'App.js,src/theme.js,src/screens/HomeScreen.js' && fl.every((b) => b.plan && b.paths.length === 3) && sent.some((b) => b.action === 'app_commit' && Object.keys(b.files).length === 3));
  check('version chip + built message', (await page.locator('.ph .chip.ok', { hasText: 'v1' }).count()) === 1 && (await page.locator('.ac-b.apok').count()) === 1);
  await page.click('[data-act="apexpo"]'); await page.waitForSelector('#apqr .qrbox svg', { timeout: 6000 });
  check('"View in Expo Go" shows a QR code + open-on-phone link', (await page.getAttribute('#apqr a.btn.p', 'href')).includes('app-export?go=app1') && (await page.locator('.apnote').count()) === 1);
  await page.click('[data-act="aptab"][data-k="files"]'); await page.waitForSelector('.aptree');
  check('files tab: tree + code viewer starts with App.js', (await page.locator('.aptree button').count()) === 5 && (await page.locator('#apcode').inputValue()).includes('// App.js'));
  await page.click('.aptree button[data-p="src/theme.js"]');
  check('clicking a file shows it', (await page.locator('#apcode').inputValue()).includes('// src/theme.js'));
  const dl = page.waitForEvent('download'); await page.click('[data-act="apzip"]'); const d = await dl;
  check('ZIP download of the project', /\.zip$/.test(d.suggestedFilename()));
  await page.click('[data-act="aptab"][data-k="build"]'); await page.waitForSelector('[data-act="apeas"]');
  check('super: 3 store-build buttons enabled', (await page.locator('[data-act="apeas"]:not([disabled])').count()) === 3);
  await page.click('[data-act="apeas"][data-pf="android"][data-pr="preview"]'); await page.waitForTimeout(500);
  check('store build sends app_build, explains when GitHub is not set up', sent.some((b) => b.action === 'app_build' && b.platform === 'android' && b.profile === 'preview') && (await page.locator('text=توكن GitHub').count()) > 0);
  check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
  await h.close();

  // super admin: users page toggles apps_access
  h = await launch({ role: 'super_admin', viewport: { width: 1200, height: 900 }, tables: { profiles: [{ id: UID, full_name: 'أدمن', role: 'super_admin', status: 'active', created_at: now }, { id: 'u2', full_name: 'عميل', role: 'customer', status: 'active', apps_access: false, created_at: now }] } });
  await h.open('#/admin/users'); await h.page.waitForSelector('[data-chg="appsacc"]', { timeout: 8000 });
  await h.page.check('[data-chg="appsacc"][data-id="u2"]'); await h.page.waitForTimeout(400);
  check('super: enabling the app builder for a user', h.calls.some((c) => c.method === 'PATCH' && /profiles/.test(c.url) && /id=eq\.u2/.test(c.url) && c.body.apps_access === true));
  await h.close();
  process.exit(fails ? 2 : 0);
})();
