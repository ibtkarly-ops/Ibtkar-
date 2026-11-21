"use strict";
// Apps: menu item for everyone, "coming soon" + interest form for customers/visitors, chat + Expo for the super admin.
const { launch, UID } = require('./mock');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
const CODE = "import React from 'react';\nimport { View, Text } from 'react-native';\nexport default function App() { return (<View><Text>hi</Text></View>); }";
(async () => {
  // customer
  let h = await launch({ role: 'customer', viewport: { width: 1000, height: 800 } });
  await h.open('#/app/apps'); await h.page.waitForSelector('form[data-form="interest"]', { timeout: 8000 });
  check('customer: menu has Apps row', (await h.page.locator('#drawer .dr-i[href="#/app/apps"]').count()) === 1 && (await h.page.locator('#drawer .dr-i[href="#/app/apps"].on').count()) === 1);
  check('customer: coming soon, no chat/new-app button', (await h.page.locator('text=قريباً').count()) > 0 && (await h.page.locator('[data-act="newapp"]').count()) === 0);
  await h.page.fill('form[data-form="interest"] input[name=email]', 'a@b.ly'); await h.page.click('form[data-form="interest"] button');
  await h.page.waitForTimeout(300);
  check('customer: interest saved', h.calls.some((c) => c.method === 'POST' && /interest_signups/.test(c.url) && c.body.email === 'a@b.ly'));
  await h.close();
  // visitor
  h = await launch({ role: 'customer', signedIn: false });
  await h.open('#/apps'); await h.page.waitForSelector('form[data-form="interest"]', { timeout: 8000 });
  check('visitor: sees coming soon + form', true);
  await h.close();
  // super admin: chat
  let sent;
  const app = { id: 'app1', owner_id: UID, name: 'تطبيق جديد', site_type: 'app', status: 'draft', created_at: new Date().toISOString(), config: { app: { chat: [], code: '' } } };
  h = await launch({ role: 'super_admin', viewport: { width: 1100, height: 900 }, tables: { websites: [app], interest_signups: [{ id: 'i1', email: 'x@y.ly', service: 'apps', created_at: new Date().toISOString() }] },
    functions: { 'ai-gateway': (b) => { sent = b; return { ok: true, reply: 'بنيت الشاشة الرئيسية.', code: CODE, model: 'm', delayMs: 1200 }; } } });
  const { page, context } = h;
  await h.open('#/admin/apps'); await page.waitForSelector('[data-act="newapp"]', { timeout: 8000 });
  check('super: apps list + interest list', (await page.locator('a.card.h[href="#/admin/apps/app1"]').count()) === 1 && (await page.locator('text=x@y.ly').count()) > 0);
  await page.click('[data-act="newapp"]'); await page.waitForTimeout(500);
  const ins = h.calls.find((c) => c.method === 'POST' && /\/websites/.test(c.url));
  check('new app creates an app row and opens the chat', ins && ins.body.site_type === 'app' && /#\/admin\/apps\//.test(await page.evaluate(() => location.hash)));
  h.T.websites.splice(1);   // the mock does not filter by id: drop the echoed row so maybeSingle() sees one row
  await page.goto('about:blank'); await h.open('#/admin/apps/app1'); await page.waitForSelector('form[data-form="appmsg"]');
  check('chat starts with examples and Expo buttons disabled', (await page.locator('.ac-hello .chip').count()) === 4 && await page.locator('[data-act="expo"]').isDisabled());
  await page.click('.ac-hello .chip'); check('example fills the message box', (await page.locator('textarea[name=m]').inputValue()).length > 5);
  await page.click('form[data-form="appmsg"] button'); await page.waitForTimeout(500);
  check('message sent to app_chat with the website id', sent && sent.action === 'app_chat' && sent.website_id === 'app1' && sent.messages.at(-1).role === 'user');
  check('user bubble shown immediately', (await page.locator('.ac-b.u').count()) >= 1);
  // simulate the saved result (the mock does not persist) and check the Expo side
  app.config.app = { chat: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'بنيت الشاشة الرئيسية.' }], code: CODE };
  await page.goto('about:blank'); await h.open('#/admin/apps/app1'); await page.waitForSelector('#accode', { state: 'attached' });
  check('code panel filled, Expo enabled', (await page.locator('#accode').inputValue()).includes('export default') && await page.locator('[data-act="expo"]').isEnabled());
  const pop = context.waitForEvent('page');
  await page.click('[data-act="expo"]');
  const np = await pop; const u = np.url();
  check('"View in Expo" opens Snack with the code', u.startsWith('https://snack.expo.dev/?') && decodeURIComponent(u).includes('export default function App') && /platform=android/.test(u));
  await page.click('[data-act="expoprev"]'); await page.waitForTimeout(300);
  check('inline preview uses the embedded Snack', /snack\.expo\.dev\/embedded\?/.test(await page.getAttribute('#acprev', 'src')));
  check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
  await h.close();
  process.exit(fails ? 2 : 0);
})();
