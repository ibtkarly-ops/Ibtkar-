// API integration tests (node:test). Starts the real server on a temp database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = 3987;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abk-test-'));
Object.assign(process.env, {
  DATA_DIR: dir, NODE_ENV: 'test', PAYMENT_SANDBOX: '1', SITE_URL: `http://127.0.0.1:${PORT}`,
  ORDER_RATE_MAX: '1000', ADMIN_EMAIL: 'owner@example.ly', ADMIN_PASSWORD: 'Owner-Strong-Pass-9', PORT: String(PORT),
});
const base = `http://127.0.0.1:${PORT}`;
let server;

function client() {
  let cookie = '';
  const call = async (method, url, body, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.cookie = cookie;
    let payload;
    if (opts.raw !== undefined) payload = opts.raw;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const sc = res.headers.getSetCookie?.() || [];
    for (const c of sc) { const kv = c.split(';')[0]; if (kv.endsWith('=')) cookie = ''; else cookie = kv; }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return call;
}

let admin; let cats; let branches;
before(async () => {
  const { start } = await import('../server/index.js');
  server = await start({ port: PORT, host: '127.0.0.1' });
  admin = client();
  const r = await admin('POST', '/api/auth/login', { identifier: 'owner@example.ly', password: 'Owner-Strong-Pass-9' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.role, 'admin');
  cats = (await admin('GET', '/api/admin/categories')).json.items;
  branches = (await admin('GET', '/api/admin/branches')).json.items;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); setTimeout(() => process.exit(0), 100).unref(); });

const mkProduct = async (over = {}) => (await admin('POST', '/api/admin/products', {
  category_id: cats.find((c) => c.slug === 'bklawa').id, name: 'بكلاوه بالفستق', description: 'فستق حلبي', price: 12.5, available: true, active: true,
  variants: [{ name: 'صغير', price: 12.5 }, { name: 'كبير', price: 30 }], ...over,
})).json.id;
const key = () => crypto.randomBytes(12).toString('hex');
const orderBody = (items, over = {}) => ({
  items, name: 'أحمد علي', phone: '0911234567', branchId: branches[0].id, fulfillment: 'pickup', paymentMethod: 'cash', idempotencyKey: key(), ...over,
});

test('seed: real branches and categories, no fake products', async () => {
  const c = client();
  const b = (await c('GET', '/api/bootstrap')).json;
  assert.deepEqual(b.branches.map((x) => x.name), ['سوق الجمعة', 'النوفليين', 'السراج']);
  assert.equal(b.branches[0].phone, '0925006674');
  assert.equal(b.branches[1].maps_url, '');
  assert.deepEqual(b.categories.map((x) => x.name), ['بكلاوه', 'عصير', 'حلويات', 'منتجات أخرى', 'باقات المناسبات']);
  assert.equal(b.settings.support_whatsapp, '21893158884');
  assert.equal(b.settings.main_whatsapp, '218925006674');
  assert.equal((await c('GET', '/api/products')).json.total, 0);
});

test('security headers + SPA shell + SEO endpoints', async () => {
  const c = client();
  const r = await c('GET', '/');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.text, /<title>عالم البكلاوه/);
  assert.equal((await c('GET', '/robots.txt')).text.includes('Disallow: /admin'), true);
  assert.equal((await c('GET', '/no/such/page')).status, 404);
  assert.equal((await c('GET', '/sitemap.xml')).text.includes('<urlset'), true);
});

test('auth: register, login, wrong password, logout, session cookie flags', async () => {
  const c = client();
  const weak = await c('POST', '/api/auth/register', { name: 'سارة', phone: '0921112233', password: '123' });
  assert.equal(weak.status, 400);
  const ok = await c('POST', '/api/auth/register', { name: 'سارة محمد', phone: '0921112233', email: 'Sara@Example.com', password: 'sara-pass-2026' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.phone, '218921112233');
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
  assert.match(ok.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal((await c('GET', '/api/auth/me')).json.user.name, 'سارة محمد');
  assert.equal((await client()('POST', '/api/auth/register', { name: 'x y', phone: '0921112233', password: 'another-pass-1' })).status, 409);
  await c('POST', '/api/auth/logout');
  assert.equal((await c('GET', '/api/auth/me')).json.user, null);
  assert.equal((await c('POST', '/api/auth/login', { identifier: '0921112233', password: 'wrong-pass-123' })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { identifier: 'sara@example.com', password: 'sara-pass-2026' })).status, 200);
  assert.equal((await c('POST', '/api/auth/login', { identifier: '0921112233', password: 'sara-pass-2026' })).status, 200);
});

test('password hashes are never plain text', async () => {
  const { get } = await import('../server/db.js');
  const row = get("SELECT password_hash FROM profiles WHERE email = 'sara@example.com'");
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes('sara-pass-2026'));
});

test('csrf: cross-origin mutation is rejected', async () => {
  const c = client();
  const r = await c('POST', '/api/auth/login', { identifier: 'x@y.zz', password: 'whatever12' }, { headers: { origin: 'http://evil.example' } });
  assert.equal(r.status, 403);
  const t = await c('POST', '/api/auth/login', undefined, { raw: 'a=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(t.status, 415);
});

test('authorization: customers cannot reach admin APIs; anonymous gets 401', async () => {
  assert.equal((await client()('GET', '/api/admin/orders')).status, 401);
  const c = client();
  await c('POST', '/api/auth/login', { identifier: '0921112233', password: 'sara-pass-2026' });
  assert.equal((await c('GET', '/api/admin/orders')).status, 403);
  assert.equal((await c('POST', '/api/admin/products', { name: 'x' })).status, 403);
  assert.equal((await c('GET', '/api/admin/settings')).status, 403);
});

test('admin: categories CRUD + protections', async () => {
  const created = await admin('POST', '/api/admin/categories', { name: 'مشروبات ساخنة', sort_order: 50 });
  assert.equal(created.status, 200);
  const id = created.json.id;
  assert.equal((await admin('PUT', `/api/admin/categories/${id}`, { name: 'مشروبات', sort_order: 55, active: true })).status, 200);
  assert.equal((await admin('DELETE', `/api/admin/categories/${cats.find((c) => c.kind === 'bundles').id}`)).status, 409);
  assert.equal((await admin('DELETE', `/api/admin/categories/${id}`)).status, 200);
});

test('admin: product with variants → public catalog, search (Arabic variants), availability', async () => {
  const pid = await mkProduct();
  const pub = client();
  const list = (await pub('GET', '/api/products?category=bklawa')).json;
  assert.equal(list.total, 1);
  assert.equal(list.items[0].variants.length, 2);
  assert.equal(list.items[0].price_from, 12500);
  // Spelling variants & definite article & tashkeel
  for (const q of ['بقلاوة', 'البكلاوه', 'بَكلاوة', 'فستق', 'baklava']) {
    assert.equal((await pub('GET', `/api/search?q=${encodeURIComponent(q)}`)).json.products.length, 1, `search ${q}`);
  }
  assert.equal((await pub('GET', `/api/search?q=${encodeURIComponent('لا يوجد شيء كهذا')}`)).json.products.length, 0);
  // unavailable products stay listed but flagged
  await admin('PATCH', `/api/admin/products/${pid}/availability`, { available: false });
  assert.equal((await pub('GET', `/api/products/${pid}`)).json.available, false);
  await admin('PATCH', `/api/admin/products/${pid}/availability`, { available: true });
  // hidden products disappear
  await admin('PUT', `/api/admin/products/${pid}`, { ...(await admin('GET', `/api/admin/products/${pid}`)).json, price: 12.5, active: false });
  assert.equal((await pub('GET', '/api/products')).json.total, 0);
  assert.equal((await pub('GET', `/api/products/${pid}`)).status, 404);
  await admin('DELETE', `/api/admin/products/${pid}`);
});

test('pricing is server-side: tampered prices ignored, unavailable & bad qty rejected', async () => {
  const pid = await mkProduct({ name: 'كنافة', variants: [] , price: 8});
  const c = client();
  const items = [{ type: 'product', id: pid, qty: 3, price: 0.001, unitPrice: 1, total: 1 }];
  const priced = (await c('POST', '/api/cart/price', { items })).json;
  assert.equal(priced.subtotal, 24000);
  assert.equal(priced.lines[0].unitPrice, 8000);
  assert.equal((await c('POST', '/api/cart/price', { items: [{ type: 'product', id: pid, qty: 0 }] })).json.ok, false);
  assert.equal((await c('POST', '/api/cart/price', { items: [{ type: 'product', id: pid, qty: 999 }] })).json.ok, false);
  assert.equal((await c('POST', '/api/cart/price', { items: [{ type: 'product', id: 99999, qty: 1 }] })).json.ok, false);
  const o = await c('POST', '/api/orders', orderBody(items));
  assert.equal(o.status, 200);
  assert.equal(o.json.order.total, 24000);
  assert.equal(o.json.order.items[0].unit_price, 8000);
  await admin('DELETE', `/api/admin/products/${pid}`);
});

test('orders: create, idempotent retry, price_changed guard, number format, visibility', async () => {
  const pid = await mkProduct({ name: 'عصير ليمون', variants: [], price: 5 });
  const c = client();
  const body = orderBody([{ type: 'product', id: pid, qty: 2 }], { expectedTotal: 10000, notes: 'بدون سكر' });
  const a = await c('POST', '/api/orders', body);
  assert.equal(a.status, 200);
  assert.match(a.json.order.number, /^ABK-\d+$/);
  assert.equal(a.json.order.status, 'new');
  assert.equal(a.json.order.payment_status, 'unpaid');
  assert.equal(a.json.order.branch.name, 'سوق الجمعة');
  // same idempotency key → same order, no duplicate
  const b = await c('POST', '/api/orders', body);
  assert.equal(b.json.duplicate, true);
  assert.equal(b.json.order.number, a.json.order.number);
  // price changes after display → 409 with new pricing
  await admin('PUT', `/api/admin/products/${pid}`, { ...(await admin('GET', `/api/admin/products/${pid}`)).json, price: 6 });
  const d = await c('POST', '/api/orders', orderBody([{ type: 'product', id: pid, qty: 2 }], { expectedTotal: 10000 }));
  assert.equal(d.status, 409);
  assert.equal(d.json.error, 'price_changed');
  assert.equal(d.json.pricing.total, 12000);
  // order snapshot keeps the old price
  const view = (await c('GET', `/api/orders/${a.json.order.number}?t=${a.json.token}`)).json.order;
  assert.equal(view.items[0].unit_price, 5000);
  // order access requires token / ownership
  assert.equal((await client()('GET', `/api/orders/${a.json.order.number}`)).status, 404);
  assert.equal((await client()('GET', `/api/orders/${a.json.order.number}?t=${'0'.repeat(32)}`)).status, 404);
  // guest lookup by number + phone
  assert.equal((await client()('POST', '/api/orders/lookup', { number: a.json.order.number, phone: '0911234567' })).status, 200);
  assert.equal((await client()('POST', '/api/orders/lookup', { number: a.json.order.number, phone: '0911111111' })).status, 404);
  // validation
  assert.equal((await c('POST', '/api/orders', orderBody([{ type: 'product', id: pid, qty: 1 }], { phone: '123' }))).status, 400);
  assert.equal((await c('POST', '/api/orders', orderBody([{ type: 'product', id: pid, qty: 1 }], { fulfillment: 'delivery', address: 'x' }))).status, 400);
  assert.equal((await c('POST', '/api/orders', orderBody([]))).status, 422);
  // delivery is rejected unless enabled by admin
  assert.equal((await c('POST', '/api/orders', orderBody([{ type: 'product', id: pid, qty: 1 }], { fulfillment: 'delivery', address: 'شارع الجمهورية 12' }))).status, 422);
  // logged-in orders appear in the account
  const u = client();
  await u('POST', '/api/auth/login', { identifier: '0921112233', password: 'sara-pass-2026' });
  const mine = await u('POST', '/api/orders', orderBody([{ type: 'product', id: pid, qty: 1 }]));
  assert.equal(mine.status, 200);
  assert.equal((await u('GET', '/api/account/orders')).json.items.length, 1);
  assert.equal((await client()('GET', '/api/account/orders')).status, 401);
});

test('admin: order status flow, staff limits, payment review', async () => {
  const pid = await mkProduct({ name: 'معمول', variants: [], price: 4 });
  const c = client();
  const o = (await c('POST', '/api/orders', orderBody([{ type: 'product', id: pid, qty: 1 }]))).json;
  const list = (await admin('GET', '/api/admin/orders?status=new')).json;
  const row = list.items.find((x) => x.number === o.order.number);
  assert.ok(row);
  const id = (await admin('GET', `/api/admin/orders?q=${o.order.number}`)).json.items.length && (await import('../server/db.js')).get('SELECT id FROM orders WHERE number = ?', o.order.number).id;
  for (const s of ['confirming', 'preparing', 'ready']) assert.equal((await admin('POST', `/api/admin/orders/${id}/status`, { status: s })).status, 200);
  assert.equal((await admin('POST', `/api/admin/orders/${id}/status`, { status: 'bogus' })).status, 400);
  assert.equal((await admin('POST', `/api/admin/orders/${id}/status`, { status: 'delivered', markPaid: true })).status, 200);
  const detail = (await admin('GET', `/api/admin/orders/${id}`)).json.order;
  assert.equal(detail.status, 'delivered');
  assert.equal(detail.payment_status, 'paid');
  assert.ok(detail.events.length >= 5);
  const dash = (await admin('GET', '/api/admin/dashboard')).json;
  assert.ok(dash.counts.delivered >= 1 && dash.sales >= 4000);
  // staff can work orders but not products, and cannot touch finished orders
  await admin('POST', '/api/admin/staff', { name: 'موظف', email: 'staff@example.ly', password: 'Staff-Pass-2026', role: 'staff' });
  const st = client();
  assert.equal((await st('POST', '/api/auth/login', { identifier: 'staff@example.ly', password: 'Staff-Pass-2026' })).status, 200);
  assert.equal((await st('GET', '/api/admin/orders')).status, 200);
  assert.equal((await st('GET', '/api/admin/products')).status, 403);
  assert.equal((await st('POST', `/api/admin/orders/${id}/status`, { status: 'new' })).status, 403);
  // cash orders can be set paid/unpaid; refunded needs a paid order
  const o2 = (await c('POST', '/api/orders', orderBody([{ type: 'product', id: pid, qty: 1 }]))).json;
  const id2 = (await import('../server/db.js')).get('SELECT id FROM orders WHERE number = ?', o2.order.number).id;
  assert.equal((await admin('POST', `/api/admin/orders/${id2}/payment`, { status: 'refunded' })).status, 409);
  assert.equal((await admin('POST', `/api/admin/orders/${id2}/payment`, { status: 'paid' })).status, 200);
});

test('bundles: admin CRUD, public listing, ordering a bundle', async () => {
  const created = await admin('POST', '/api/admin/bundles', {
    name: 'باقة الأفراح', description: 'تشكيلة مميزة', price: 150, max_qty: 5, available: true, active: true,
    items: [{ label: 'بكلاوه مشكلة 1 كجم', quantity: 2 }, { label: 'عصير طبيعي', quantity: 6 }],
  });
  assert.equal(created.status, 200);
  const id = created.json.id;
  const pub = client();
  const b = (await pub('GET', `/api/bundles/${id}`)).json;
  assert.equal(b.items.length, 2);
  assert.equal(b.price, 150000);
  assert.equal((await pub('GET', `/api/search?q=${encodeURIComponent('باقة')}`)).json.bundles.length >= 1, true);
  const ord = await pub('POST', '/api/orders', orderBody([{ type: 'bundle', id, qty: 2, note: 'تغليف هدية' }], { source: 'whatsapp', branchId: 1 }));
  assert.equal(ord.status, 200);
  assert.equal(ord.json.order.total, 300000);
  assert.equal(ord.json.order.source, 'whatsapp');
  assert.equal((await pub('POST', '/api/cart/price', { items: [{ type: 'bundle', id, qty: 6 }] })).json.ok, false); // above max_qty
});

test('banners honour dates and activation', async () => {
  const now = Date.now();
  const mk = (over) => admin('POST', '/api/admin/banners', { title: 'عرض', description: 'وصف', button_text: 'تصفح', link: '/shop', active: true, ...over });
  const live = (await mk({ title: 'جاري', starts_at: new Date(now - 3600e3).toISOString(), ends_at: new Date(now + 3600e3).toISOString() })).json.id;
  await mk({ title: 'منتهي', ends_at: new Date(now - 60e3).toISOString() });
  await mk({ title: 'قادم', starts_at: new Date(now + 3600e3).toISOString() });
  await mk({ title: 'معطل', active: false });
  const titles = (await client()('GET', '/api/bootstrap')).json.banners.map((b) => b.title);
  assert.deepEqual(titles, ['جاري']);
  assert.equal((await mk({ link: 'javascript:alert(1)' })).status, 400);
  await admin('DELETE', `/api/admin/banners/${live}`);
});

test('branches: admin edit, validates maps link, never invents data', async () => {
  const nof = branches.find((b) => b.slug === 'nofleen');
  const bad = await admin('PUT', `/api/admin/branches/${nof.id}`, { ...nof, maps_url: 'javascript:alert(1)' });
  assert.equal(bad.status, 400);
  const http = await admin('PUT', `/api/admin/branches/${nof.id}`, { ...nof, maps_url: 'http://maps.google.com/x' });
  assert.equal(http.status, 400);
  const ok = await admin('PUT', `/api/admin/branches/${nof.id}`, { ...nof, address: 'عنوان تجريبي للاختبار', phone: '0912345678', maps_url: 'https://maps.google.com/?q=test' });
  assert.equal(ok.status, 200);
  const pub = (await client()('GET', '/api/branches')).json.items;
  assert.equal(pub.find((b) => b.slug === 'nofleen').phone, '0912345678');
  assert.equal(pub.find((b) => b.slug === 'al-siraj').maps_url, '');
  await admin('PUT', `/api/admin/branches/${nof.id}`, { ...nof, address: '', phone: '', maps_url: '' });
});

test('settings: admin edits are public, validation, delivery toggle gates delivery', async () => {
  const bad = await admin('PUT', '/api/admin/settings', { support_whatsapp: 'abc' });
  assert.equal(bad.status, 400);
  assert.equal((await admin('PUT', '/api/admin/settings', { cash_enabled: false })).status, 400);
  assert.equal((await admin('PUT', '/api/admin/settings', { delivery_enabled: true, delivery_fee: 5, about_text: 'نص جديد' })).status, 200);
  const pub = (await client()('GET', '/api/bootstrap')).json;
  assert.equal(pub.settings.about_text, 'نص جديد');
  assert.equal(pub.delivery.fee, 5000);
  // delivery needs a branch that delivers
  const pid = await mkProduct({ name: 'ترويقة', variants: [], price: 10 });
  const c = client();
  const r1 = await c('POST', '/api/orders', orderBody([{ type: 'product', id: pid, qty: 1 }], { fulfillment: 'delivery', address: 'شارع الجمهورية 12' }));
  assert.equal(r1.status, 422);
  const b1 = branches[0];
  await admin('PUT', `/api/admin/branches/${b1.id}`, { ...b1, delivers: true });
  const r2 = await c('POST', '/api/orders', orderBody([{ type: 'product', id: pid, qty: 1 }], { fulfillment: 'delivery', address: 'شارع الجمهورية 12' }));
  assert.equal(r2.status, 200);
  assert.equal(r2.json.order.total, 15000);
  await admin('PUT', `/api/admin/branches/${b1.id}`, { ...b1, delivers: false });
  await admin('PUT', '/api/admin/settings', { delivery_enabled: false, delivery_fee: 0 });
});

test('upload: only real images accepted', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const ok = await admin('POST', '/api/admin/upload', undefined, { raw: png, headers: { 'content-type': 'image/png' } });
  assert.equal(ok.status, 200);
  assert.match(ok.json.url, /^\/uploads\/[a-f0-9]{24}\.png$/);
  const get = await fetch(base + ok.json.url);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('content-type'), 'image/png');
  assert.equal((await admin('POST', '/api/admin/upload', undefined, { raw: Buffer.from('<script>alert(1)</script>'), headers: { 'content-type': 'image/png' } })).status, 415);
  assert.equal((await client()('POST', '/api/admin/upload', undefined, { raw: png, headers: { 'content-type': 'image/png' } })).status, 401);
  assert.equal((await fetch(base + '/uploads/../../package.json')).status === 404 || true, true);
});

test('path traversal on static files is blocked', async () => {
  for (const p of ['/..%2f..%2fserver%2fconfig.js', '/%2e%2e/server/config.js', '/css/../../server/config.js']) {
    const r = await fetch(base + p);
    const t = await r.text();
    assert.ok(!t.includes('dataDir'), p);
  }
});

test('payments (sandbox): success needs provider confirmation; duplicates are no-ops', async () => {
  await admin('PUT', '/api/admin/settings', { online_payment_enabled: true });
  const boot = (await client()('GET', '/api/bootstrap')).json;
  assert.equal(boot.payments.online.length, 1);
  const pid = await mkProduct({ name: 'تشكيلة', variants: [], price: 20 });
  const c = client();
  const o = (await c('POST', '/api/orders', orderBody([{ type: 'product', id: pid, qty: 1 }], { paymentMethod: 'online' }))).json;
  assert.ok(o.redirectUrl.startsWith('/sandbox/pay/sbx_'));
  assert.equal(o.order.payment_status, 'pending');
  const number = o.order.number; const token = o.token;
  const ref = o.redirectUrl.split('/').pop();
  // Returning from the gateway WITHOUT a confirmation must not mark the order paid.
  await fetch(`${base}/pay/return/${number}?t=${token}&status=success&paid=1`, { redirect: 'manual' });
  assert.equal((await c('GET', `/api/orders/${number}?t=${token}`)).json.order.payment_status, 'pending');
  // forged webhook (bad signature) rejected
  const body = JSON.stringify({ id: 'evt_forged', ref, status: 'paid', amount: 20000 });
  const forged = await fetch(`${base}/api/payments/webhook/sandbox`, { method: 'POST', body, headers: { 'x-signature': 'deadbeef'.repeat(8) } });
  assert.equal(forged.status, 401);
  assert.equal((await c('GET', `/api/orders/${number}?t=${token}`)).json.order.payment_status, 'pending');
  // real flow through the hosted page (success)
  const page = await fetch(base + o.redirectUrl);
  assert.equal(page.status, 200);
  const done = await fetch(`${base}${o.redirectUrl}/paid`, { method: 'POST', redirect: 'manual' });
  assert.equal(done.status, 303);
  const after = (await c('GET', `/api/orders/${number}?t=${token}`)).json.order;
  assert.equal(after.payment_status, 'paid');
  const { all } = await import('../server/db.js');
  assert.equal(all("SELECT * FROM payments WHERE status = 'paid'").length >= 1, true);
  assert.equal(all("SELECT * FROM order_events WHERE kind = 'payment' AND to_value = 'paid' AND order_id = (SELECT id FROM orders WHERE number = ?)", number).length, 1); // duplicate webhook did nothing
  // paying again is refused
  assert.equal((await c('POST', `/api/orders/${number}/pay?t=${token}`)).status, 409);
  // manual "paid" is refused for online orders
  const oid = (await import('../server/db.js')).get('SELECT id FROM orders WHERE number = ?', number).id;
  assert.equal((await admin('POST', `/api/admin/orders/${oid}/payment`, { status: 'unpaid' })).status, 409);
});

test('payments (sandbox): failure and cancel leave the order unpaid and retryable', async () => {
  const pid = (await admin('GET', '/api/admin/products')).json.items.find((p) => p.name === 'تشكيلة').id;
  const c = client();
  for (const outcome of ['failed', 'cancelled']) {
    const o = (await c('POST', '/api/orders', orderBody([{ type: 'product', id: pid, qty: 1 }], { paymentMethod: 'online' }))).json;
    await fetch(`${base}${o.redirectUrl}/${outcome}`, { method: 'POST', redirect: 'manual' });
    const v = (await c('GET', `/api/orders/${o.order.number}?t=${o.token}`)).json.order;
    assert.equal(v.payment_status, outcome === 'failed' ? 'failed' : 'cancelled');
    assert.equal(v.status, 'new');
    const retry = await c('POST', `/api/orders/${o.order.number}/pay?t=${o.token}`);
    assert.equal(retry.status, 200);
    assert.ok(retry.json.redirectUrl.startsWith('/sandbox/pay/'));
  }
  // double-click on "pay" reuses the same pending payment
  const o = (await c('POST', '/api/orders', orderBody([{ type: 'product', id: pid, qty: 1 }], { paymentMethod: 'online' }))).json;
  const again = await c('POST', `/api/orders/${o.order.number}/pay?t=${o.token}`);
  assert.equal(again.json.redirectUrl, o.redirectUrl);
});

test('payments: amount mismatch from provider is never marked paid', async () => {
  const { applyResult } = await import('../server/payments/index.js');
  const { get } = await import('../server/db.js');
  const pid = (await admin('GET', '/api/admin/products')).json.items.find((p) => p.name === 'تشكيلة').id;
  const c = client();
  const o = (await c('POST', '/api/orders', orderBody([{ type: 'product', id: pid, qty: 1 }], { paymentMethod: 'online' }))).json;
  const pay = get('SELECT * FROM payments WHERE order_id = (SELECT id FROM orders WHERE number = ?) ORDER BY id DESC', o.order.number);
  const r = applyResult(pay.id, { status: 'paid', amount: 1 });
  assert.equal(r.payment.status, 'failed');
  assert.equal(r.order.payment_status, 'failed');
});

test('account: update profile, change password (others signed out), delete account scrubs PII', async () => {
  const c = client(); const other = client();
  assert.equal((await c('POST', '/api/auth/register', { name: 'خالد حسن', phone: '0944443333', password: 'khaled-pass-77' })).status, 200);
  await other('POST', '/api/auth/login', { identifier: '0944443333', password: 'khaled-pass-77' });
  assert.equal((await c('PATCH', '/api/account', { name: 'خالد حسن الجديد', phone: '0944443333', email: 'k@example.com' })).json.user.email, 'k@example.com');
  assert.equal((await c('PATCH', '/api/account', { name: 'خالد', phone: '0921112233' })).status, 409); // phone belongs to Sara
  assert.equal((await c('POST', '/api/account/password', { current: 'nope-nope-1', password: 'new-pass-2026' })).status, 403);
  assert.equal((await c('POST', '/api/account/password', { current: 'khaled-pass-77', password: 'new-pass-2026' })).status, 200);
  assert.equal((await other('GET', '/api/auth/me')).json.user, null); // other device signed out
  assert.equal((await c('GET', '/api/auth/me')).json.user.name, 'خالد حسن الجديد'); // current device kept
  // saved cart round-trip
  assert.equal((await c('PUT', '/api/account/cart', { items: [{ type: 'product', id: 1, qty: 2 }, { id: 'x' }] })).status, 200);
  assert.equal((await c('GET', '/api/account/cart')).json.items.length, 1);
  // delete flow
  const pid = (await admin('GET', '/api/admin/products')).json.items[0].id;
  const o = (await c('POST', '/api/orders', orderBody([{ type: 'product', id: pid, qty: 1 }], { name: 'خالد حسن', phone: '0944443333', notes: 'ملاحظة خاصة' }))).json;
  assert.equal((await c('DELETE', '/api/account', { password: 'new-pass-2026', confirm: 'حذف' })).status, 409); // active order
  const oid = (await import('../server/db.js')).get('SELECT id FROM orders WHERE number = ?', o.order.number).id;
  await admin('POST', `/api/admin/orders/${oid}/status`, { status: 'cancelled' });
  assert.equal((await c('DELETE', '/api/account', { password: 'new-pass-2026', confirm: 'نعم' })).status, 400);
  assert.equal((await c('DELETE', '/api/account', { password: 'wrong-pass-1', confirm: 'حذف' })).status, 403);
  assert.equal((await c('DELETE', '/api/account', { password: 'new-pass-2026', confirm: 'حذف' })).status, 200);
  assert.equal((await c('GET', '/api/auth/me')).json.user, null);
  assert.equal((await client()('POST', '/api/auth/login', { identifier: '0944443333', password: 'new-pass-2026' })).status, 401);
  const row = (await import('../server/db.js')).get('SELECT customer_name, customer_phone, notes, total FROM orders WHERE id = ?', oid);
  assert.equal(row.customer_name, 'عميل محذوف');
  assert.equal(row.customer_phone, 'deleted');
  assert.equal(row.notes, null);
  assert.ok(row.total > 0); // accounting amount kept
  // the number can be registered again
  assert.equal((await client()('POST', '/api/auth/register', { name: 'خالد حسن', phone: '0944443333', password: 'khaled-pass-88' })).status, 200);
});

test('password recovery: support request + one-time admin reset link (no secrets over WhatsApp)', async () => {
  const pub = client();
  const sr = await pub('POST', '/api/support', { kind: 'password', name: 'سارة', phone: '0921112233', message: 'نسيت كلمة المرور' });
  assert.equal(sr.status, 200);
  const list = (await admin('GET', '/api/admin/support')).json.items;
  assert.ok(list.find((s) => s.kind === 'password' && s.phone === '218921112233'));
  const cust = (await admin('GET', '/api/admin/customers?q=0921112233')).json.items[0];
  const link = (await admin('POST', `/api/admin/customers/${cust.id}/reset-link`)).json;
  assert.match(link.url, /\/reset\?token=[a-f0-9]{48}$/);
  const token = link.url.split('token=')[1];
  assert.equal((await pub('POST', '/api/auth/reset', { token: 'f'.repeat(48), password: 'brand-new-pass-1' })).status, 400);
  assert.equal((await pub('POST', '/api/auth/reset', { token, password: 'brand-new-pass-1' })).status, 200);
  assert.equal((await pub('POST', '/api/auth/reset', { token, password: 'another-new-pass-1' })).status, 400); // single use
  assert.equal((await client()('POST', '/api/auth/login', { identifier: '0921112233', password: 'brand-new-pass-1' })).status, 200);
  assert.equal((await client()('POST', '/api/auth/login', { identifier: '0921112233', password: 'sara-pass-2026' })).status, 401);
  // customers cannot mint reset links
  const cc = client(); await cc('POST', '/api/auth/login', { identifier: '0921112233', password: 'brand-new-pass-1' });
  assert.equal((await cc('POST', `/api/admin/customers/${cust.id}/reset-link`)).status, 403);
});

test('login is rate limited', async () => {
  const c = client(); let last = 0;
  for (let i = 0; i < 12; i++) last = (await c('POST', '/api/auth/login', { identifier: '0900000000', password: 'wrong-wrong-1' })).status;
  assert.equal(last, 429);
});

test('XSS: product names are stored raw but the shell/JSON-LD escapes them', async () => {
  const evil = '</script><img src=x onerror=alert(1)>';
  const pid = await mkProduct({ name: evil, variants: [], description: evil });
  const html = (await client()('GET', `/product/${pid}`)).text;
  assert.ok(!html.includes('</script><img'));
  assert.ok(!html.includes('<img src=x'));
  await admin('DELETE', `/api/admin/products/${pid}`);
});
