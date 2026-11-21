"use strict";
// 20 MB per-site image cap: usage readout in the Items tab, and a friendly message
// (instead of a raw storage error) when an upload would exceed the limit.
const { launch, UID } = require('./mock');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
(async () => {
  const boot = await launch({ role: 'customer' }); await boot.open('#/'); await boot.page.waitForTimeout(300);
  const html = await boot.page.evaluate(() => genSite({ name: 'ملكي', type: 'store', lang: 'ar', phone: '0912345678', desc: 'متجر' }));
  await boot.close();
  const w = { id: 's1', owner_id: UID, name: 'ملكي', slug: 'royal', site_type: 'store', status: 'draft', created_at: new Date().toISOString(), config: { html } };

  // ---- usage readout reflects site_asset_bytes() ----
  {
    const h = await launch({ role: 'customer', tables: { websites: [w] }, rpc: { site_asset_bytes: 2 * 1048576 } });
    await h.open('#/app/site/s1/items'); await h.page.waitForSelector('form[data-form="items"]', { timeout: 8000 });
    check('usage readout shows MB used of 20', (await h.page.locator('#storageUse').innerText()) === '2.0');
    await h.close();
  }

  // ---- successful upload refreshes the readout ----
  {
    let bytes = 1048576; // 1 MB already used
    const h = await launch({ role: 'customer', tables: { websites: [w] }, rpc: { site_asset_bytes: () => bytes } });
    await h.open('#/app/site/s1/items'); await h.page.waitForSelector('form[data-form="items"]', { timeout: 8000 });
    check('starts at 1.0 MB', (await h.page.locator('#storageUse').innerText()) === '1.0');
    bytes = 1148576; // pretend the upload added ~100KB
    await h.page.locator('.irow').first().locator('[data-up=item]').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: png });
    await h.page.waitForTimeout(700);
    check('readout refreshes after a successful upload without a full page reload', (await h.page.locator('#storageUse').innerText()) === '1.1');
    await h.close();
  }

  // ---- rejected upload (quota exceeded) shows the friendly message, not a raw error ----
  {
    const h = await launch({ role: 'customer', tables: { websites: [w] }, rpc: { site_asset_bytes: 19.8 * 1048576 } });
    // the site-assets upload endpoint: simulate the DB trigger rejecting the insert
    await h.page.route('**/storage/v1/object/site-assets/**', (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'site_storage_quota_exceeded' }) })
    );
    await h.open('#/app/site/s1/items'); await h.page.waitForSelector('form[data-form="items"]', { timeout: 8000 });
    check('usage shown near the cap', (await h.page.locator('#storageUse').innerText()) === '19.8');
    await h.page.locator('.irow').first().locator('[data-up=item]').setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: png });
    await h.page.waitForTimeout(700);
    check('friendly quota message shown, not the raw error code', await h.page.locator('text=اكتملت مساحة الصور المتاحة لهذا الموقع').count() === 1 && await h.page.locator('text=site_storage_quota_exceeded').count() === 0);
    check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
    await h.close();
  }
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 2 : 0);
})();
