// Cloudflare Worker checks (local D1 via `wrangler dev`). Covers what differs from the Node server:
// edge-served static files, D1-backed uploads / rate limits / setup, atomic order creation under concurrency.
//   WRANGLER=/path/to/wrangler node --test tests/worker.test.js     (skipped when WRANGLER is not set)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const WRANGLER = process.env.WRANGLER;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const procs = [];
async function boot(port, vars = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abk-worker-'));
  const args = ['dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', dir, '--var', 'NODE_ENV:test', '--var', 'PAYMENT_SANDBOX:1',
    ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])];
  const p = spawn(WRANGLER, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = ''; p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
  procs.push({ p, dir });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(base + '/healthz')).ok) return base; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  throw new Error('wrangler dev did not start:\n' + log.slice(-1500));
}
after(() => { for (const { p, dir } of procs) { try { process.kill(-p.pid); } catch { /* gone */ } fs.rmSync(dir, { recursive: true, force: true }); } setTimeout(() => process.exit(0), 200).unref(); });

function client(base) {
  let cookie = '';
  return async (method, url, body, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.cookie = cookie;
    let payload;
    if (opts.raw !== undefined) payload = opts.raw;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() || []) { const kv = c.split(';')[0]; cookie = kv.endsWith('=') ? '' : kv; }
    const buf = Buffer.from(await res.arrayBuffer()); const text = buf.toString('utf8');
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, buf, headers: res.headers };
  };
}

const skip = WRANGLER ? false : 'set WRANGLER=/path/to/wrangler to run the Cloudflare Worker tests';
let base; let admin; let branches; let productId;
const OWNER = { name: 'مالك المتجر', email: 'owner@example.ly', phone: '0911112222', password: 'Owner-Strong-Pass-9', confirm: 'Owner-Strong-Pass-9' };

test('boot: migrations run on D1, real seed, no fake products', { skip }, async () => {
  base = await boot(3995, { ORDER_RATE_MAX: 500 });
  const c = client(base);
  const b = (await c('GET', '/api/bootstrap')).json;
  assert.deepEqual(b.branches.map((x) => x.name), ['سوق الجمعة', 'النوفليين', 'السراج']);
  assert.equal(b.settings.logo_url, '/assets/logo.webp');
  assert.equal((await c('GET', '/api/products')).json.total, 0);
  assert.equal((await c('GET', '/healthz')).text, 'ok');
});

test('static files come straight from the edge (not the Worker); pages go through the Worker', { skip }, async () => {
  const c = client(base);
  const css = await c('GET', '/css/app.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-security-policy'), null);            // Worker did not run
  assert.equal(css.headers.get('x-content-type-options'), 'nosniff');         // from public/_headers
  assert.equal((await c('GET', '/admin/admin.js')).headers.get('content-security-policy'), null);
  assert.equal((await c('GET', '/assets/logo.webp')).status, 200);
  const home = await c('GET', '/');
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(home.text, /<title>عالم البكلاوه/);
  assert.match(home.text, /id="boot"/);                                       // bootstrap data embedded for first paint
  assert.equal((await c('GET', '/nope')).status, 404);
  assert.equal((await c('GET', '/admin')).status, 200);
  assert.equal((await c('GET', '/_headers')).status, 404);                    // config files are not public
});

test('first run on Workers: owner creates the account from the browser, then it closes for good', { skip }, async () => {
  const c = client(base);
  const st = (await c('GET', '/api/setup/status')).json;
  assert.deepEqual([st.needsSetup, st.needsCode, st.openClaim], [true, false, true]);
  assert.equal((await c('POST', '/api/setup', { ...OWNER, password: 'short', confirm: 'short' })).status, 400);
  const r = await c('POST', '/api/setup', OWNER);
  assert.equal(r.status, 200); assert.equal(r.json.user.role, 'admin');
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await c('GET', '/api/auth/me')).json.user.email, OWNER.email);
  assert.equal((await client(base)('POST', '/api/setup', { ...OWNER, email: 'other@example.ly' })).status, 409);
  assert.equal((await c('GET', '/api/setup/status')).json.needsSetup, false);
  admin = client(base);
  assert.equal((await admin('POST', '/api/auth/login', { identifier: OWNER.email, password: OWNER.password })).status, 200);
  branches = (await admin('GET', '/api/admin/branches')).json.items;
});

test('images are stored in D1 and served with long-lived cache headers', { skip }, async () => {
  const up = await admin('POST', '/api/admin/upload', undefined, { raw: PNG, headers: { 'content-type': 'image/png' } });
  assert.equal(up.status, 200); assert.match(up.json.url, /^\/uploads\/[a-f0-9]{24}\.png$/);
  const img = await client(base)('GET', up.json.url);
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('cache-control'), /immutable/);
  assert.ok(img.buf.equals(PNG));
  assert.equal((await admin('POST', '/api/admin/upload', undefined, { raw: Buffer.from('<?php echo 1;'), headers: { 'content-type': 'image/png' } })).status, 415);
  assert.equal((await admin('POST', '/api/admin/upload', undefined, { raw: Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]) })).status, 413);
  assert.equal((await client(base)('GET', '/uploads/../../etc/passwd')).status, 404);
  assert.equal((await client(base)('GET', '/uploads/aaaaaaaaaaaaaaaaaaaaaaaa.png')).status, 404);
  assert.equal((await client(base)('POST', '/api/admin/upload', undefined, { raw: PNG })).status, 401);
  // a product that uses the uploaded image
  const cats = (await admin('GET', '/api/admin/categories')).json.items;
  const made = await admin('POST', '/api/admin/products', {
    category_id: cats.find((x) => x.slug === 'bklawa').id, name: 'بكلاوه بالفستق', description: 'فستق حلبي', price: 12.5, image: up.json.url, available: true, active: true,
    variants: [{ name: 'صغير', price: 12.5 }, { name: 'كبير', price: 30 }],
  });
  assert.equal(made.status, 200); productId = made.json.id;
});

test('catalog, Arabic search, SEO page and sitemap work from D1', { skip }, async () => {
  const c = client(base);
  const list = (await c('GET', '/api/products')).json;
  assert.equal(list.total, 1); assert.equal(list.items[0].variants.length, 2);
  assert.equal((await c('GET', '/api/search?q=' + encodeURIComponent('بكلاوة'))).json.products.length, 1); // ة / ه normalisation
  assert.equal((await c('GET', '/api/search?q=' + encodeURIComponent('كنافه'))).json.products.length, 0);
  const page = await c('GET', `/product/${productId}`);
  assert.equal(page.status, 200); assert.match(page.text, /application\/ld\+json/); assert.match(page.text, /بكلاوه بالفستق/);
  assert.match((await c('GET', '/sitemap.xml')).text, new RegExp(`/product/${productId}<`));
  assert.equal((await c('GET', '/product/99999')).status, 200); // SPA shell; the view shows "not found"
});

test('orders: concurrent duplicates become one order; numbers never collide', { skip }, async () => {
  const c = client(base);
  const body = (key, over = {}) => ({ items: [{ type: 'product', id: productId, variantId: undefined, qty: 1 }], name: 'أحمد علي', phone: '0911234567', branchId: branches[0].id, fulfillment: 'pickup', paymentMethod: 'cash', idempotencyKey: key, ...over });
  const variant = (await c('GET', `/api/products/${productId}`)).json.product?.variants?.[0] ?? (await c('GET', '/api/products')).json.items[0].variants[0];
  const items = [{ type: 'product', id: productId, variantId: variant.id, qty: 1 }];
  const before = (await admin('GET', '/api/admin/orders')).json.total;
  const key = crypto.randomBytes(12).toString('hex');
  const same = await Promise.all(Array.from({ length: 6 }, () => c('POST', '/api/orders', body(key, { items }))));
  assert.ok(same.every((r) => r.status === 200), JSON.stringify(same.map((r) => [r.status, r.json?.error, r.json?.message])));
  assert.equal(new Set(same.map((r) => r.json.order.number)).size, 1);
  assert.equal((await admin('GET', '/api/admin/orders')).json.total, before + 1);
  const distinct = await Promise.all(Array.from({ length: 6 }, () => c('POST', '/api/orders', body(crypto.randomBytes(12).toString('hex'), { items }))));
  assert.ok(distinct.every((r) => r.status === 200), JSON.stringify(distinct.map((r) => [r.status, r.json?.error, r.json?.message])));
  assert.equal(new Set(distinct.map((r) => r.json.order.number)).size, 6);
  assert.ok(distinct.every((r) => /^ABK-\d{4,}$/.test(r.json.order.number)));
  assert.equal((await admin('GET', '/api/admin/orders')).json.total, before + 7);
  // server prices: tampering is ignored
  const tampered = await c('POST', '/api/orders', body(crypto.randomBytes(12).toString('hex'), { items: [{ ...items[0], price: 1 }], expectedTotal: 1 }));
  assert.ok([200, 409].includes(tampered.status), tampered.status + ' ' + tampered.text);
  if (tampered.status === 200) assert.equal(tampered.json.order.total, 12500);
});

test('online payment (sandbox gateway): paid only after the gateway confirms, duplicates are no-ops', { skip }, async () => {
  const c = client(base);
  const made = await admin('POST', '/api/admin/payment-gateways', { type: 'sandbox', label: 'بوابة الاختبار', enabled: true, mode: 'test', config: {}, secrets: {} });
  assert.equal(made.status, 200, made.text);
  const gid = made.json.id;
  const variant = (await c('GET', '/api/products')).json.items[0].variants[0];
  const oRes = await c('POST', '/api/orders', { items: [{ type: 'product', id: productId, variantId: variant.id, qty: 1 }], name: 'سالم', phone: '0922223333', branchId: branches[0].id, fulfillment: 'pickup', paymentMethod: `online:${gid}`, idempotencyKey: crypto.randomBytes(12).toString('hex') });
  assert.equal(oRes.status, 200, oRes.text); const o = oRes.json;
  assert.match(o.redirectUrl, /^\/sandbox\/pay\//);
  const token = o.token ?? o.order.token; const number = o.order.number;
  const status = async () => (await c('GET', `/api/orders/${number}?t=${token}`)).json.order.payment_status;
  assert.equal(await status(), 'pending');
  assert.equal((await fetch(base + o.redirectUrl)).status, 200);
  assert.equal((await fetch(`${base}${o.redirectUrl}/paid`, { method: 'POST', redirect: 'manual' })).status, 303);
  assert.equal(await status(), 'paid');
  const detail = (await admin('GET', `/api/admin/orders?q=${number}`)).json.items[0];
  const events = (await admin('GET', `/api/admin/orders/${detail.id}`)).json.order.events.filter((e) => e.kind === 'payment' && e.to_value === 'paid');
  assert.equal(events.length, 1);
});

test('gateway secrets are masked in the API and the key survives (stored in D1)', { skip }, async () => {
  const made = await admin('POST', '/api/admin/payment-gateways', { type: 'plutu', label: 'بطاقات ليبية', enabled: false, mode: 'test', config: { gateway: 'tlync' }, secrets: { api_key: 'PLUTU-KEY-123456', access_token: 'TOKEN-ABCDEF', secret_key: 'SUPER-SECRET-9' } });
  assert.equal(made.status, 200, made.text);
  const text = (await admin('GET', '/api/admin/payment-gateways')).text;
  assert.ok(!text.includes('PLUTU-KEY-123456') && !text.includes('SUPER-SECRET-9') && !text.includes('TOKEN-ABCDEF'));
  assert.equal(made.json.item.secrets_masked.api_key, '••••456');
  const upd = await admin('PUT', `/api/admin/payment-gateways/${made.json.id}`, { label: 'بطاقات', mode: 'test', enabled: false, config: made.json.item.config, secrets: {} });
  assert.equal(upd.json.item.secrets_masked.secret_key, '••••T-9'); // decrypted with the same key on a later request
});

test('rate limiting is shared through D1 (login brute force is slowed down)', { skip }, async () => {
  const c = client(base);
  const codes = [];
  for (let i = 0; i < 14; i++) codes.push((await c('POST', '/api/auth/login', { identifier: '0933334444', password: 'wrong-pass-' + i })).status);
  assert.ok(codes.includes(401) && codes.includes(429), codes.join(','));
});

test('customer account: register, login, delete', { skip }, async () => {
  const c = client(base);
  assert.equal((await c('POST', '/api/auth/register', { name: 'سارة محمد', phone: '0921112233', password: 'sara-pass-2026' })).status, 200);
  assert.equal((await c('GET', '/api/auth/me')).json.user.name, 'سارة محمد');
  assert.equal((await c('GET', '/api/admin/orders')).status, 403);
  assert.equal((await c('DELETE', '/api/account', { password: 'sara-pass-2026', confirm: 'حذف' })).status, 200);
  assert.equal((await c('GET', '/api/auth/me')).json.user, null);
});

test('SETUP_CODE protects the first-run form on a fresh Worker', { skip }, async () => {
  const b2 = await boot(3996, { SETUP_CODE: 'ABCD-2345' });
  const c = client(b2);
  const st = (await c('GET', '/api/setup/status')).json;
  assert.deepEqual([st.needsSetup, st.needsCode, st.openClaim], [true, true, false]);
  assert.match(st.codeWhere, /SETUP_CODE/);
  assert.equal((await c('POST', '/api/setup', OWNER)).status, 403);
  assert.equal((await c('POST', '/api/setup', { ...OWNER, code: 'WRONG-CODE' })).status, 403);
  assert.equal((await c('POST', '/api/setup', { ...OWNER, code: 'abcd 2345' })).status, 200);
  assert.equal((await client(b2)('POST', '/api/setup', { ...OWNER, code: 'ABCD2345', email: 'x@y.ly' })).status, 409);
});
