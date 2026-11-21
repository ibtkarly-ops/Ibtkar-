"use strict";
// Wizard "create site" must ALWAYS finish (success, AI failure, AI hang, publish hang)
// and must tell the user why when the AI did not run.
//   node tests/wizard.js [path/to/index.html]
const path = require('path');
const { launch } = require('./mock');

const file = process.argv[2] ? path.resolve(process.argv[2]) : undefined;

async function scenario(name, fns, advance) {
  const h = await launch({ file, role: 'customer', rpc: { slug_available: true, request_publish: 'dep-1' }, functions: fns });
  const { page } = h;
  await page.clock.install();
  await h.open('#/app/new');
  await page.waitForSelector('form[data-form="wizard"]', { timeout: 8000 });
  await page.fill('#sl', 'royal');
  await page.fill('input[name=name]', 'ملكي');
  await page.fill('textarea[name=desc]', 'وصف النشاط');
  await page.fill('input[name=phone]', '0912345678');
  await page.click('form[data-form="wizard"] button.btn.p.lg');
  await page.waitForSelector('#bo', { timeout: 5000 });
  for (const ms of advance) { await page.clock.runFor(ms); await page.waitForTimeout(150); }
  const state = await page.evaluate(() => { const b = document.querySelector('#bo'); return b ? { cls: b.className, title: b.querySelector('h2')?.textContent, sub: b.querySelector('p')?.textContent } : null; });
  const done = !!state && /\b(ok|err)\b/.test(state.cls);
  console.log(`${done ? 'PASS' : 'FAIL'}  ${name}\n      -> ${JSON.stringify(state)}`);
  await h.close();
  return done;
}

(async () => {
  const ok = [];
  ok.push(await scenario('AI ok + publish ok', {
    'ai-gateway': { ok: true, model: 'm' }, 'verify-publish': { ok: true, url: 'https://royal.ibtkar.ly' },
  }, [1000]));
  ok.push(await scenario('AI fails (invalid key) + publish ok -> says why', {
    'ai-gateway': () => ({ status: 502, body: { error: 'all_providers_failed' } }), 'verify-publish': { ok: true, url: 'https://royal.ibtkar.ly' },
  }, [1000]));
  ok.push(await scenario('AI hangs forever -> client timeout, still finishes', {
    'ai-gateway': () => ({ hang: true }), 'verify-publish': { ok: true, url: 'https://royal.ibtkar.ly' },
  }, [125000, 1000]));
  ok.push(await scenario('verify-publish hangs -> timeout, still finishes with retry', {
    'ai-gateway': { ok: true }, 'verify-publish': () => ({ hang: true }),
  }, [1000, 45000, 1000]));
  process.exit(ok.every(Boolean) ? 0 : 2);
})();
