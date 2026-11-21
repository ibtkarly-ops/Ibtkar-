"use strict";
// Login first (signup below), forgot password, forgot email (WhatsApp + code), reset password.
const { launch } = require('./mock');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
(async () => {
  const h = await launch({ role: 'customer', signedIn: false, viewport: { width: 1000, height: 800 }, tables: { platform_settings: [{ key: 'public.support_whatsapp', value: '218912345678' }], account_help_requests: [], plans: [] } });
  const { page } = h;
  await h.open('#/');
  await page.waitForSelector('.lp-hero', { timeout: 8000 });
  check('nav has Login as the single entry button', (await page.locator('#auth a').count()) === 1 && /login/.test(await page.locator('#auth a').getAttribute('href')));
  check('hero CTA opens login (not signup)', (await page.locator('.lp-hero a.lp-c').getAttribute('href')) === '#/login');
  await page.click('#auth a');
  await page.waitForSelector('form[data-form="login"]');
  check('login page: forgot password + forgot email links', (await page.locator('.auth-links a[href="#/forgot"]').count()) === 1 && (await page.locator('.auth-links a[href="#/help"]').count()) === 1);
  const order = await page.evaluate(() => { const f = document.querySelector('form[data-form="login"]'), s = document.querySelector('a.btn.s[href="#/signup"]'); return !!(f.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING); });
  check('create-account button sits BELOW the login form', order);
  await page.click('.pweye'); check('show-password toggle works', (await page.locator('form[data-form="login"] input[name=pass]').getAttribute('type')) === 'text');
  await page.click('a.btn.s[href="#/signup"]'); await page.waitForSelector('form[data-form="signup"]');
  check('signup page has "sign in" below', (await page.locator('a.btn.s[href="#/login"]').count()) === 1);
  await h.open('#/forgot'); await page.waitForSelector('form[data-form="forgot"]');
  await page.fill('input[name=email]', 'a@b.ly'); await page.click('form[data-form="forgot"] button'); await page.waitForTimeout(500);
  check('forgot: recovery email requested', h.calls.some((c) => /auth\/v1\/recover/.test(c.url)));
  check('forgot: neutral confirmation shown', (await page.locator('.auth .card').innerText()).length > 20);
  await h.open('#/help'); await page.waitForSelector('.help-code');
  const code = (await page.locator('.help-code').innerText()).trim();
  check('help: 6-digit code on screen (' + code + ')', /^\d{6}$/.test(code));
  const wa = await page.locator('a[href^="https://wa.me/"]').getAttribute('href');
  check('help: WhatsApp link to support number carrying the code', wa.startsWith('https://wa.me/218912345678') && decodeURIComponent(wa).includes(code));
  await page.waitForTimeout(300);
  check('help: request stored for the admin', h.calls.some((c) => c.method === 'POST' && /account_help_requests/.test(c.url) && c.body.code === code));
  check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
  await h.close();
  // reset page (signed in via recovery link)
  const r = await launch({ role: 'customer', viewport: { width: 1000, height: 800 } });
  await r.open('#/reset'); await r.page.waitForSelector('form[data-form="reset"]');
  await r.page.fill('input[name=pass]', 'newpassword1'); await r.page.click('form[data-form="reset"] button.btn.p'); await r.page.waitForTimeout(600);
  check('reset: password update sent', r.calls.some((c) => /auth\/v1\/user/.test(c.url) && (c.method === 'PUT') && c.body && c.body.password === 'newpassword1'));
  await r.close();
  // admin: support number + requests list
  const a = await launch({ role: 'super_admin', viewport: { width: 1000, height: 900 }, tables: { platform_settings: [{ key: 'public.sites_base_url', value: 'https://x.pages.dev' }, { key: 'public.support_whatsapp', value: '' }], account_help_requests: [{ id: 'q1', code: '123456', handled: false, created_at: new Date().toISOString() }] } });
  await a.open('#/admin/settings'); await a.page.waitForSelector('form[data-form="support"]');
  check('admin sees the help request code', (await a.page.locator('text=123456').count()) > 0);
  await a.page.fill('form[data-form="support"] input[name=num]', '0912345678'); await a.page.click('form[data-form="support"] button'); await a.page.waitForTimeout(400);
  check('admin saves the support number (international)', a.calls.some((c) => /platform_settings/.test(c.url) && c.body && c.body.key === 'public.support_whatsapp' && c.body.value === '218912345678'));
  await a.close();
  process.exit(fails ? 2 : 0);
})();
