"use strict";
// Central contract system (UI): the customer reads every page, agrees, draws a signature, confirms; the admin uploads the one
// official contract image, places the signature boxes, and manages every contract. All server rules live in the database and
// the contract-center function (tests/contract-center.test.ts + SQL tests); here we check what the browser does and sends.
const zlib = require('zlib');
const { launch, UID } = require('./mock');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
const now = new Date().toISOString();
const CID = '11111111-1111-4111-8111-111111111111', CID2 = '22222222-2222-4222-8222-222222222222', CID3 = '33333333-3333-4333-8333-333333333333';
const pages = [{ url: 'https://x.supabase.co/storage/p1.png', w: 1024, h: 1536 }, { url: 'https://x.supabase.co/storage/p2.png', w: 1024, h: 1536 }, { url: 'https://x.supabase.co/storage/p3.png', w: 1024, h: 1536 }];
const pc = (o) => ({ customer_id: UID, website_id: 'w1', template_version_id: 'v1', delivered_at: now, created_at: now, ...o });
// a valid, noisy PNG (so it is > 1 KB like a real scan)
function png(w = 700, h = 900) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const o = Buffer.alloc(12 + d.length); o.writeUInt32BE(d.length, 0); o.write(t, 4); d.copy(o, 8); o.writeUInt32BE(crc(o.subarray(4, 8 + d.length)), 8 + d.length); return o; };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 255); let r = 7; for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; for (let x = 0; x < w; x += 7) { r = (r * 1103515245 + 12345) & 0x7fffffff; raw[y * (w + 1) + 1 + x] = (r >> 8) & 255; } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const drawSig = async (page) => {
  const box = await page.locator('#esigncv').boundingBox();
  await page.mouse.move(box.x + 30, box.y + 60); await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 30 + i * 14, box.y + 60 + (i % 2 ? 30 : -30));
  await page.mouse.up();
};
(async () => {
  // ---------- customer: list ----------
  {
    const h = await launch({ role: 'customer', viewport: { width: 390, height: 844 }, tables: { project_contracts: [pc({ id: CID, status: 'awaiting_signature', contract_number: 'IBT-C-2026-0001' }), pc({ id: CID2, status: 'approved', contract_number: 'IBT-C-2026-0002', signed_at: now, final_pdf_path: 'x/final.pdf' })], websites: [{ id: 'w1', name: 'موقعي', owner_id: UID }] } });
    await h.open('#/app/contracts'); await h.page.waitForSelector('.ctcard', { timeout: 8000 });
    const txt = await h.page.locator('#v').innerText();
    check('list shows both contracts with their numbers and the site name', /IBT-C-2026-0001/.test(txt) && /IBT-C-2026-0002/.test(txt) && /موقعي/.test(txt));
    check('pending contract offers "review and sign"; approved one offers the signed copy', (await h.page.locator('a[href="#/app/contracts/' + CID + '"]').innerText()).includes('توقيع') && (await h.page.locator('[data-act="ctfinal"]').count()) === 1);
    check('no horizontal scroll on a phone', (await h.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);
    check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
    await h.close();
  }
  // ---------- customer: read every page, agree, sign ----------
  {
    const posts = []; let signed = false;
    const h = await launch({ role: 'customer', viewport: { width: 390, height: 844 },
      tables: { project_contracts: [pc({ id: CID, status: 'awaiting_signature', contract_number: 'IBT-C-2026-0001' })], websites: [{ id: 'w1', name: 'موقعي', owner_id: UID }], contract_events: [], contract_signatures: [] },
      functions: { 'contract-center': (b) => { if (b.action === 'urls') return { ok: true, version: 1, pages }; if (b.action === 'sign') { posts.push(b); signed = true; return { ok: true, number: 'IBT-C-2026-0001' }; } return { error: 'bad_request' }; } } });
    const { page } = h; page.on('dialog', (d) => d.accept());
    await h.open('#/app/contracts/' + CID); await page.waitForSelector('#ctview .ctpg', { timeout: 8000 });
    check('all contract pages are rendered as images from short-lived links', (await page.locator('.ctpg img').count()) === 3);
    check('the agree button is locked until every page was read', await page.locator('#ctgo').isDisabled());
    check('the progress line shows how many pages were read', /\/ 3/.test(await page.locator('#ctprog').innerText()));
    await page.click('[data-act="ctzoom"][data-d="1"]'); check('zoom in works (150%)', (await page.locator('#ctzl').innerText()) === '150%');
    await page.click('[data-act="ctzoom"][data-d="0"]'); check('fit resets the zoom', (await page.locator('#ctzl').innerText()) === '100%');
    await page.click('[data-act="ctnav"][data-d="1"]'); await page.waitForTimeout(500);
    for (let i = 0; i < 3; i++) { await page.evaluate((k) => { const e = document.querySelectorAll('.ctpg')[k]; window.scrollTo(0, e.getBoundingClientRect().top + scrollY - innerHeight / 2 + 40); }, i); await page.waitForTimeout(450); }
    await page.waitForFunction(() => !document.querySelector('#ctgo').disabled, null, { timeout: 5000 });
    check('after scrolling through every page the agree button unlocks', !(await page.locator('#ctgo').isDisabled()));
    check('"all pages read" is reported to the server (once)', h.calls.filter((c) => c.url.includes('/rpc/ct_pages_seen')).length === 1);
    check('opening the contract marks it viewed', h.calls.some((c) => c.url.includes('/rpc/ct_mark_viewed')));
    check('the signature form is hidden until the customer agrees', !(await page.locator('#ctsignbox').isVisible()));
    await page.click('#ctgo'); await page.waitForSelector('#esigncv', { state: 'visible' });
    await page.fill('#esignname', 'أيوب'); await page.click('[data-act="ctsign"]'); await page.waitForTimeout(300);
    check('a blank signature is refused (nothing sent)', posts.length === 0);
    await drawSig(page); await page.click('[data-act="ctsign"]'); await page.waitForTimeout(300);
    check('without the confirmation box nothing is sent', posts.length === 0);
    await page.check('#ctconfirm'); await page.click('[data-act="ctsign"]'); await page.waitForFunction(() => true); await page.waitForTimeout(900);
    const p = posts[0] || {};
    check('one sign request with agree, typed name, a signature PNG and the name PNG', posts.length === 1 && p.contract_id === CID && p.agree === true && p.name_text === 'أيوب' && p.signature_b64.length > 600 && p.name_b64.length > 200);
    check('the signature is a real PNG (not a data URL, not empty)', Buffer.from(p.signature_b64 || '', 'base64').subarray(1, 4).toString() === 'PNG');
    check('the browser never sends a status, a hash or a path (the server decides)', !('status' in p) && !('final_sha256' in p) && !('path' in p));
    check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
    await h.close();
  }
  // ---------- customer: signed / someone else's contract ----------
  {
    const h = await launch({ role: 'customer', tables: { project_contracts: [pc({ id: CID, status: 'signed', contract_number: 'IBT-C-2026-0001', signed_at: now, final_pdf_path: 'x/final.pdf' })], websites: [{ id: 'w1', name: 'موقعي', owner_id: UID }], contract_events: [], contract_signatures: [{ contract_id: CID, signer_name: 'أيوب', signed_at: now, final_sha256: 'f'.repeat(64) }] },
      functions: { 'contract-center': { ok: true, version: 1, pages, final_url: 'https://x.supabase.co/storage/final.pdf' } } });
    await h.open('#/app/contracts/' + CID); await h.page.waitForSelector('#ctview', { timeout: 8000 });
    check('a signed contract has no signing form, only the signed copy and a waiting note', (await h.page.locator('#ctsign').count()) === 0 && (await h.page.locator('[data-act="ctfinal"]').count()) === 1 && /اعتماد/.test(await h.page.locator('#v').innerText()));
    await h.close();
    const h2 = await launch({ role: 'customer', tables: { project_contracts: [], websites: [] }, functions: { 'contract-center': { error: 'not_found', _s: 404 } } });
    await h2.open('#/app/contracts/' + CID3); await h2.page.waitForSelector('.empty', { timeout: 8000 });
    check('a contract that is not yours simply is not found', (await h2.page.locator('#ctview').count()) === 0);
    await h2.close();
    const h3 = await launch({ role: 'customer', tables: {} });
    await h3.open('#/c/61066f39-8c51-4649-be21-c4d52ca562a6'); await h3.page.waitForSelector('.empty', { timeout: 8000 });
    check('an old contract link points to the new "my contracts" page', (await h3.page.locator('a[href="#/app/contracts"]').count()) >= 1);
    await h3.close();
  }
  // ---------- admin ----------
  const cust = { id: 'c1', full_name: 'عميل تجريبي', role: 'customer', status: 'active' };
  const adminTables = () => ({
    profiles: [{ id: UID, full_name: 'أدمن', role: 'super_admin', status: 'active' }, cust], websites: [{ id: 'w1', name: 'موقع العميل', owner_id: 'c1', status: 'draft' }, { id: 'w2', name: 'موقع فشل', owner_id: 'c1', status: 'draft' }],
    contract_templates: [{ id: 't1', active: true, auto_send: true, active_version_id: 'v1' }],
    contract_template_versions: [{ id: 'v1', version: 3, pages: [{ path: 'a', w: 1024, h: 1536 }], created_at: now, original_sha256: 'ab'.repeat(32) }],
    project_contracts: [pc({ id: CID, customer_id: 'c1', status: 'signed', contract_number: 'IBT-C-1', signed_at: now }), pc({ id: CID2, customer_id: 'c1', status: 'awaiting_signature', contract_number: 'IBT-C-2' }), pc({ id: CID3, customer_id: 'c1', status: 'approved', contract_number: 'IBT-C-3', signed_at: now })],
    contract_delivery_logs: [{ id: 1, website_id: 'w2', status: 'failed', error: 'no_active_template', created_at: now }],
    contract_events: [{ id: 1, contract_id: CID, type: 'delivered', created_at: now }, { id: 2, contract_id: CID, type: 'signed', created_at: now }],
    contract_signatures: [{ contract_id: CID, signer_name: 'عميل', signed_at: now, ip: '1.2.3.4', original_sha256: 'a'.repeat(64), final_sha256: 'b'.repeat(64) }],
  });
  {
    const ups = [];
    const h = await launch({ role: 'super_admin', viewport: { width: 1200, height: 1100 }, tables: adminTables(), rpc: { ct_stats: { awaiting_signature: 1, signed: 1, approved: 1, failed_deliveries: 1 } },
      functions: { 'contract-center': (b) => { if (b.action === 'urls') return { ok: true, version: 3, pages, layout: {} }; if (b.action === 'template_upload') { ups.push(b); return { ok: true, version_id: 'v9' }; } return { error: 'bad_request' }; } } });
    const { page } = h; page.on('dialog', (d) => d.accept());
    await h.open('#/admin/contracts'); await page.waitForSelector('#ctadm table', { timeout: 8000 });
    const txt = await page.locator('#ctadm').innerText();
    check('official contract card: active version, pages and the original hash', /v3/.test(txt) && /abababab/.test(txt));
    check('all three contracts are listed with customer and site', /IBT-C-1/.test(txt) && /IBT-C-2/.test(txt) && /IBT-C-3/.test(txt) && /عميل تجريبي/.test(txt) && /موقع العميل/.test(txt));
    check('approve is offered only for the signed contract', (await page.locator('[data-act="ctact"][data-k="approve"]').count()) === 1 && (await page.locator('[data-act="ctact"][data-k="approve"]').getAttribute('data-id')) === CID);
    check('resend is offered only for the pending contract', (await page.locator('[data-act="ctact"][data-k="resend"]').count()) === 1);
    check('a ready site that never got a contract is listed with a retry button', (await page.locator('[data-act="ctissue"][data-site="w2"]').count()) === 1);
    await page.click('[data-act="ctact"][data-k="approve"]'); await page.waitForTimeout(500);
    const ap = h.calls.find((c) => c.url.includes('/rpc/ct_admin_action'));
    check('approve goes through the database function (not a direct table update)', !!ap && ap.body.p_action === 'approve' && ap.body.p_contract === CID && !h.calls.some((c) => c.method === 'PATCH' && c.url.includes('project_contracts')));
    await page.click('[data-chg="ctflag"][data-k="auto"]'); await page.waitForTimeout(400);
    const fl = h.calls.find((c) => c.url.includes('/rpc/ct_set_template_flags'));
    check('auto-send switch calls the settings function with only that flag', !!fl && fl.body.p_auto === false && fl.body.p_active === null);
    await page.click('[data-act="ctlog"][data-id="' + CID + '"]'); await page.waitForSelector('#ctov', { timeout: 4000 });
    check('the log shows the signer, the hashes and the events', /1\.2\.3\.4/.test(await page.locator('#ctov').innerText()) && /aaaaaaaa/.test(await page.locator('#ctov').innerText()) && /وُقّع/.test(await page.locator('#ctov').innerText()));
    await page.click('[data-act="ctclose"]');
    // upload with the placement editor
    await page.setInputFiles('#ctfiles', [{ name: '2.png', mimeType: 'image/png', buffer: png() }, { name: '1.png', mimeType: 'image/png', buffer: png() }]);
    await page.waitForSelector('#cted .ctbox', { timeout: 4000 });
    check('selected pages are ordered by file name and shown as thumbnails', (await page.locator('#ctupui .ctth').count()) === 2);
    check('three draggable boxes: signature, name, date', (await page.locator('#cted .ctbox').count()) === 3);
    await page.locator('#cted').scrollIntoViewIfNeeded();
    const bx = await page.locator('.ctbox[data-k="sig"]').boundingBox();
    const before = await page.locator('.ctbox[data-k="sig"]').evaluate((e) => e.style.left);
    await page.mouse.move(bx.x + bx.width / 2, bx.y + bx.height / 2); await page.mouse.down(); await page.mouse.move(bx.x + bx.width / 2 - 60, bx.y + bx.height / 2 - 40, { steps: 5 }); await page.mouse.up();
    check('dragging moves the signature box', (await page.locator('.ctbox[data-k="sig"]').evaluate((e) => e.style.left)) !== before);
    check('the box stays inside the page image', await page.locator('.ctbox[data-k="sig"]').evaluate((e) => parseFloat(e.style.left) >= 0 && parseFloat(e.style.top) >= 0 && parseFloat(e.style.left) + parseFloat(e.style.width) <= 100.1 && parseFloat(e.style.top) + parseFloat(e.style.height) <= 100.1));
    await page.click('[data-act="ctmv"][data-i="0"][data-d="1"]');
    await page.click('[data-act="ctupload"]'); await page.waitForTimeout(1200);
    const u = ups[0] || {};
    check('one upload with both pages (base64 originals), the layout fractions and the signature page', ups.length === 1 && u.pages.length === 2 && u.pages.every((q) => Buffer.from(q.b64, 'base64').subarray(1, 4).toString() === 'PNG') && u.layout.sig.page === 1 && u.layout.sig.w > 0 && u.layout.date.h > 0);
    check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
    await h.close();
  }
  // a plain admin (not super) can look and approve, but not upload or change the settings
  {
    const t = adminTables(); t.profiles[0].role = 'admin';
    const h = await launch({ role: 'admin', viewport: { width: 1200, height: 1000 }, tables: t, rpc: { ct_stats: {} }, functions: { 'contract-center': { ok: true, version: 3, pages, layout: {} } } });
    await h.open('#/admin/contracts'); await h.page.waitForSelector('#ctadm table', { timeout: 8000 });
    check('admin (not super): no upload input and the switches are disabled', (await h.page.locator('#ctfiles').count()) === 0 && (await h.page.locator('[data-chg="ctflag"]:not([disabled])').count()) === 0);
    check('admin (not super) can still approve a signed contract', (await h.page.locator('[data-act="ctact"][data-k="approve"]').count()) === 1);
    await h.close();
  }
  // admin opens a customer's contract: sees the pages and the signed copy, but never a signing form
  {
    const h = await launch({ role: 'super_admin', tables: adminTables(), functions: { 'contract-center': { ok: true, version: 3, pages } } });
    await h.open('#/admin/contracts/' + CID); await h.page.waitForSelector('#ctview', { timeout: 8000 });
    check('admin viewer: pages shown, no signing form, approve/reject offered', (await h.page.locator('.ctpg').count()) === 3 && (await h.page.locator('#ctsign').count()) === 0 && (await h.page.locator('[data-act="ctact"][data-k="approve"]').count()) === 1);
    await h.close();
  }
  console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
})();
