"use strict";
// Reproduces "the site freezes until restart": signed-in session, user sends
// the app to the background and back (supabase-js then emits SIGNED_IN /
// TOKEN_REFRESHED while holding its auth lock) and then navigates. If the
// onAuthStateChange callback awaits Supabase calls the next navigation
// never leaves the loading skeleton.
//
//   node tests/repro-hang.js [path/to/index.html]
const path = require('path');
const { launch, sleep } = require('./mock');

(async () => {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const h = await launch({ file, role: 'customer', expiresIn: 200, tables: { websites: [{ id: 's1', name: 'موقعي', status: 'draft', site_type: 'company', config: {}, owner_id: 'x', created_at: new Date().toISOString() }] } });
  const { page } = h;
  await h.open('#/app');
  await page.waitForSelector('.tb', { timeout: 10000 }).catch(() => {});
  console.log('dashboard rendered:', !!(await page.$('.tb')));
  await page.evaluate(() => { window.__ev = []; sb.auth.onAuthStateChange((e) => { window.__ev.push(e); }); });

  let results = [];
  for (let round = 1; round <= 3; round++) {
    // background -> foreground (what a phone does when you switch apps)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      window.dispatchEvent(new Event('visibilitychange',{bubbles:true}));
    });
    await sleep(200);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      window.dispatchEvent(new Event('visibilitychange',{bubbles:true}));
    });
    await sleep(600);
    await page.evaluate((r) => { location.hash = r % 2 ? '#/app/sites' : '#/app'; }, round);
    const t0 = Date.now();
    const ok = await page.waitForFunction(() => !document.querySelector('#v .sk') && document.querySelector('#v').innerText.trim().length > 5, null, { timeout: 8000 }).then(() => true).catch(() => false);
    results.push({ round, ok, ms: Date.now() - t0 });
  }
  console.log(JSON.stringify(results));
  console.log('auth events seen:', JSON.stringify(await page.evaluate(() => window.__ev)));
  console.log('errors:', JSON.stringify(h.errors));
  await h.close();
  process.exit(results.every((r) => r.ok) ? 0 : 2);
})();
