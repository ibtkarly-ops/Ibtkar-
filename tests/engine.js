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
    'ai-gateway': (b) => { last = b; return b.key === 'bad' ? { ok: false, error: 'invalid_key', hint: 'wrong_key_for_claude' } : { ok: true, provider: { id: 'p1' }, models: [], tested: { ok: true } }; },
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
  await page.click('[data-act="mtoggle"][data-id="m3"]');
  await page.waitForTimeout(300);
  check('toggle model writes ai_models', h.calls.some((c) => c.method === 'PATCH' && /ai_models/.test(c.url)));
  await page.click('[data-act="pmodels"]');
  await page.waitForTimeout(300);
  check('refresh calls action=models', last && last.action === 'models' && last.provider_id === 'p1');
  check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
  await h.close();
  process.exit(fails ? 2 : 0);
})();
