"use strict";
// Engine page: ONE connect card (no duplicate forms), key -> models discovered, errors explained.
//   node tests/engine.js [--shot dir]
const { launch } = require('./mock');
const fs = require('fs');
const shotDir = process.argv.includes('--shot') ? process.argv[process.argv.indexOf('--shot') + 1] : null;
let fails = 0;
const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };

(async () => {
  const tables = {
    ai_providers: [{ id: 'p1', name: 'Gemini', kind: 'gemini', priority: 100, enabled: true, health: 'healthy', secret_id: 's', last_error: null }],
    ai_models: [
      { id: 'm1', provider_id: 'p1', model_id: 'gemini-flash-latest', enabled: true, usage_type: 'general' },
      { id: 'm2', provider_id: 'p1', model_id: 'gemini-flash-lite-latest', enabled: true, usage_type: 'general' },
      { id: 'm3', provider_id: 'p1', model_id: 'gemini-pro-latest', enabled: false, usage_type: 'general' },
    ],
  };
  let last;
  const h = await launch({ role: 'super_admin', tables, viewport: { width: 1000, height: 900 }, functions: {
    'ai-gateway': (b) => { last = b; return b.key === 'bad' ? { ok: false, error: 'invalid_key', hint: 'wrong_key_for_claude', status: 401, provider: 'Claude', detail: '{"error":"invalid x-api-key"}' } : { ok: true, provider: { id: 'p1' }, models: [], tested: { ok: true } }; },
  } });
  const { page } = h;
  await h.open('#/admin/engine');
  await page.waitForSelector('form[data-form="connect"]', { timeout: 8000 });
  check('only one add form', (await page.locator('form[data-form="provider"],form[data-form="preset"]').count()) === 0);
  check('custom fields hidden for gemini', await page.locator('#cx').isHidden());
  check('model chips shown', (await page.locator('[data-act="mtoggle"]').count()) === 3);
  check('active models highlighted', (await page.locator('[data-act="mtoggle"].on').count()) === 2);
  if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await page.screenshot({ path: shotDir + '/engine.png', fullPage: true }); }
  await page.click('[data-kind="custom"]');
  check('custom shows endpoint field', await page.locator('#cx').isVisible());
  await page.click('[data-kind="anthropic"]');
  await page.fill('input[name=key]', 'bad');  // too short is client-valid (server decides)
  await page.fill('input[name=key]', 'sk-xxxxxxxxxxxx');
  await page.click('form[data-form="connect"] button');
  await page.waitForTimeout(400);
  check('connect sent kind+key', last && last.action === 'connect' && last.kind === 'anthropic' && last.key === 'sk-xxxxxxxxxxxx');
  await page.fill('input[name=key]', 'bad');
  await page.click('form[data-form="connect"] button');
  await page.waitForTimeout(300);
  const toast = await page.locator('#toast').innerText();
  check('error explained in Arabic (' + toast.replace(/\n/g, ' ') + ')', /المفتاح غير صالح/.test(toast));
  check('provider answer (HTTP status + detail) is shown under the form', /401/.test(await page.locator('#cres').innerText()) && /invalid x-api-key/.test(await page.locator('#cres').innerText()));
  await page.click('[data-act="mtoggle"][data-id="m3"]');
  await page.waitForTimeout(300);
  check('toggle model writes ai_models', h.calls.some((c) => c.method === 'PATCH' && /ai_models/.test(c.url)));
  // curl mode + visible provider error
  await page.click('[data-act="cmode"][data-mode="curl"]');
  check('curl tab shows the textarea', await page.locator('#cm-curl textarea').isVisible() && await page.locator('#cm-key').isHidden());
  await page.fill('#cm-curl textarea', 'curl https://api.groq.com/openai/v1/chat/completions -H "Authorization: Bearer gsk_x"');
  await page.click('#cm-curl button.btn.p'); await page.waitForTimeout(400);
  check('curl sent as-is to the gateway', last && last.action === 'connect' && /api\.groq\.com/.test(last.curl));
  check('groq is one of the provider chips', (await page.locator('[data-act="pickkind"][data-kind="groq"]').count()) === 1);
  // providers from the awesome-freellm list: every chip shows its free limit + a "get a key" link; Cloudflare asks for the Account ID
  await page.click('[data-act="cmode"][data-mode="key"]');
  await page.click('[data-kind="nvidia"]');
  check('picking a provider shows its free limit and a key link (new tab)', /40 RPM/.test(await page.locator('#cinfo').innerText()) && (await page.locator('#cinfo a[target="_blank"]').getAttribute('href')).includes('build.nvidia.com'));
  check('Account ID field hidden for other providers', await page.locator('#cacc').isHidden());
  check('every provider chip has a key link', await page.evaluate(() => [...document.querySelectorAll('.pk[data-act="pickkind"]')].every((b) => b.dataset.kind === 'custom' || (PROV_INFO[b.dataset.kind] && /^https:\/\//.test(PROV_INFO[b.dataset.kind][0])))));
  await page.click('[data-kind="cloudflare"]');
  check('Cloudflare shows the Account ID field', await page.locator('#cacc').isVisible());
  last = null; await page.fill('input[name=key]', 'cf-token-xxxxxxxx'); await page.fill('input[name=account_id]', 'not-an-id');
  await page.click('#cm-key form[data-form="connect"] button.btn.p'); await page.waitForTimeout(300);
  check('a wrong Account ID is refused before anything is sent', last === null && /Account ID/.test(await page.locator('#toast').innerText()));
  await page.fill('input[name=account_id]', '0123456789ABCDEF0123456789abcdef');
  await page.click('#cm-key form[data-form="connect"] button.btn.p'); await page.waitForTimeout(400);
  check('Cloudflare connect sends kind + key + account_id', last && last.action === 'connect' && last.kind === 'cloudflare' && last.account_id === '0123456789ABCDEF0123456789abcdef' && last.key === 'cf-token-xxxxxxxx');
  await page.click('[data-act="pmodels"]');
  await page.waitForTimeout(300);
  check('refresh calls action=models', last && last.action === 'models' && last.provider_id === 'p1');
  check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
  await h.close();
  process.exit(fails ? 2 : 0);
})();
