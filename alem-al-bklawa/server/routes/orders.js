// Orders (create / view / track) and the payment endpoints (return URL, webhook, sandbox gateway page).
import crypto from 'node:crypto';
import { all, get, run, tx } from '../db.js';
import { getSettings } from '../settings.js';
import { priceCart } from '../pricing.js';
import { config } from '../config.js';
import { HttpError, str, int, normalizePhone, emailOrEmpty, bad, ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from '../lib.js';
import { rateLimit, readBody, redirect, send, randomHex } from '../http.js';
import { onlineMethods, startPayment, handleReturn, handleWebhook, getGateway, gatewayIdOf } from '../payments/index.js';
import { TYPES } from '../payments/registry.js';

// ── Views ──────────────────────────────────────────────────────────────────
const branchContact = (id) => id ? get('SELECT id, name, address, phone, whatsapp, maps_url, hours FROM branches WHERE id = ?', id) : null;

export function orderView(o, { withItems = true, withEvents = false } = {}) {
  const v = {
    number: o.number, status: o.status, status_label: ORDER_STATUS_LABELS[o.status],
    payment_method: o.payment_method, payment_status: o.payment_status, payment_status_label: PAYMENT_STATUS_LABELS[o.payment_status],
    fulfillment: o.fulfillment, address: o.address, notes: o.notes, source: o.source,
    subtotal: o.subtotal, delivery_fee: o.delivery_fee, total: o.total, currency: o.currency,
    customer_name: o.customer_name, customer_phone: o.customer_phone,
    branch: branchContact(o.branch_id) || { name: o.branch_name },
    created_at: o.created_at, updated_at: o.updated_at,
  };
  if (withItems) v.items = all('SELECT kind, name, variant_name, unit_price, quantity, line_total, note FROM order_items WHERE order_id = ? ORDER BY id', o.id);
  if (withEvents) v.events = all("SELECT kind, from_value, to_value, note, created_at FROM order_events WHERE order_id = ? ORDER BY id", o.id);
  return v;
}
export const orderListView = (rows) => rows.map((o) => ({ ...orderView(o, { withItems: false }), item_count: get('SELECT COALESCE(SUM(quantity),0) AS n FROM order_items WHERE order_id = ?', o.id).n }));

const tokenEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function findAuthorised(ctx, number) {
  const o = get('SELECT * FROM orders WHERE number = ?', number);
  if (!o) throw new HttpError(404, 'not_found', 'الطلب غير موجود');
  const t = ctx.query.get('t') || '';
  const owner = ctx.user && o.user_id === ctx.user.id;
  const staff = ctx.user && (ctx.user.role === 'admin' || ctx.user.role === 'staff');
  if (!(owner || staff || (t && tokenEq(t, o.public_token)))) throw new HttpError(404, 'not_found', 'الطلب غير موجود');
  return o;
}

// ── Create ─────────────────────────────────────────────────────────────────
async function createOrder(ctx) {
  if (!rateLimit(`order:${ctx.ip}`, config.orderRateMax, 10 * 60_000)) throw new HttpError(429, 'rate_limited', 'طلبات كثيرة، انتظر قليلًا ثم أعد المحاولة.');
  const b = await ctx.json(16 * 1024);
  const settings = getSettings();

  const name = str(b.name, { min: 2, max: 80, required: true, field: 'name' });
  const phone = normalizePhone(b.phone);
  if (!phone) throw bad('invalid_phone', 'رقم الهاتف غير صالح', { field: 'phone' });
  const email = emailOrEmpty(b.email);
  const notes = str(b.notes, { max: 500, field: 'notes' });
  const fulfillment = b.fulfillment === 'delivery' ? 'delivery' : 'pickup';
  const address = fulfillment === 'delivery' ? str(b.address, { min: 5, max: 300, required: true, field: 'address' }) : '';
  const source = b.source === 'whatsapp' ? 'whatsapp' : 'web';
  const idem = str(b.idempotencyKey, { min: 16, max: 80, required: true, field: 'idempotencyKey' });
  if (!/^[A-Za-z0-9_-]+$/.test(idem)) throw bad('invalid_idempotencyKey', 'مفتاح غير صالح');
  const branchId = int(b.branchId, { min: 1, field: 'branchId' });
  const branch = get('SELECT * FROM branches WHERE id = ? AND active = 1', branchId);
  if (!branch || !branch.accepts_orders) throw bad('invalid_branch', 'الفرع المختار لا يستقبل الطلبات حاليًا', { field: 'branchId' });

  let method = 'cash';
  if (source !== 'whatsapp' && typeof b.paymentMethod === 'string' && b.paymentMethod.startsWith('online:')) {
    const gid = Number(b.paymentMethod.slice(7));
    if (!onlineMethods().some((m) => m.id === gid)) throw bad('payment_unavailable', 'طريقة الدفع الإلكتروني غير متاحة حاليًا', { field: 'paymentMethod' });
    method = `online:${gid}`;
  }
  if (method === 'cash' && !settings.cash_enabled) throw bad('payment_unavailable', 'طريقة الدفع غير متاحة', { field: 'paymentMethod' });

  // Duplicate submit / retry → return the original order untouched.
  const dup = get('SELECT * FROM orders WHERE idempotency_key = ?', idem);
  if (dup) return { duplicate: true, order: orderView(dup), token: dup.public_token, redirectUrl: null };

  const pricing = priceCart(b.items, { fulfillment, branchId });
  if (!pricing.ok) throw new HttpError(422, 'cart_invalid', 'بعض الأصناف في سلتك لم تعد متاحة', { pricing });
  if (b.expectedTotal !== undefined && b.expectedTotal !== null && Number(b.expectedTotal) !== pricing.total) {
    throw new HttpError(409, 'price_changed', 'تغيّر السعر منذ آخر عرض. راجع الإجمالي الجديد قبل التأكيد.', { pricing });
  }

  const token = randomHex(16);
  const order = tx(() => {
    const info = run(
      `INSERT INTO orders (number, public_token, user_id, customer_name, customer_phone, customer_email, branch_id, branch_name,
                           fulfillment, address, notes, subtotal, delivery_fee, total, currency, payment_method, payment_status,
                           status, source, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', 'new', ?, ?)`,
      'TMP-' + randomHex(6), token, ctx.user?.id ?? null, name, phone, email || null, branch.id, branch.name,
      fulfillment, address || null, notes || null, pricing.subtotal, pricing.deliveryFee, pricing.total, settings.currency,
      method, source, idem);
    const id = Number(info.lastInsertRowid);
    const number = `ABK-${1000 + id}`;
    run('UPDATE orders SET number = ? WHERE id = ?', number, id);
    for (const l of pricing.lines) {
      run(`INSERT INTO order_items (order_id, kind, product_id, variant_id, bundle_id, name, variant_name, unit_price, quantity, line_total, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, l.type, l.type === 'product' ? l.id : null, l.variantId, l.type === 'bundle' ? l.id : null,
        l.name, l.variantName, l.unitPrice, l.qty, l.lineTotal, l.note || null);
    }
    run("INSERT INTO order_events (order_id, kind, to_value, note, user_id) VALUES (?, 'created', 'new', ?, ?)", id,
      source === 'whatsapp' ? 'طلب مسجّل من الموقع (باقة عبر واتساب)' : 'طلب جديد من الموقع', ctx.user?.id ?? null);
    return get('SELECT * FROM orders WHERE id = ?', id);
  });

  let redirectUrl = null; let paymentError = null;
  if (method.startsWith('online:')) {
    try { redirectUrl = (await startPayment(order)).redirectUrl; }
    catch (e) { console.error('[orders] payment start failed:', e.message); paymentError = 'تعذّر بدء الدفع الإلكتروني. تم حفظ طلبك ويمكنك إعادة المحاولة من صفحة الطلب.'; }
  }
  return { duplicate: false, order: orderView(get('SELECT * FROM orders WHERE id = ?', order.id)), token, redirectUrl, paymentError };
}

export function register(r) {
  r.post('/api/orders', createOrder);

  r.get('/api/orders/:number', (ctx) => {
    const o = findAuthorised(ctx, ctx.params.number);
    return { order: orderView(o, { withEvents: true }), token: o.public_token };
  });

  // Guest tracking: order number + the phone used for the order.
  r.post('/api/orders/lookup', async (ctx) => {
    if (!rateLimit(`lookup:${ctx.ip}`, 10, 10 * 60_000)) throw new HttpError(429, 'rate_limited', 'محاولات كثيرة، انتظر قليلًا.');
    const b = await ctx.json();
    const number = str(b.number, { max: 30, required: true, field: 'number' }).toUpperCase();
    const phone = normalizePhone(b.phone);
    const o = get('SELECT * FROM orders WHERE number = ?', number);
    if (!o || !phone || o.customer_phone !== phone) throw new HttpError(404, 'not_found', 'لم نجد طلبًا بهذه البيانات');
    return { order: orderView(o, { withEvents: true }), token: o.public_token };
  });

  // (Re)start online payment for an unpaid order.
  r.post('/api/orders/:number/pay', async (ctx) => {
    if (!rateLimit(`pay:${ctx.ip}`, 10, 10 * 60_000)) throw new HttpError(429, 'rate_limited', 'محاولات كثيرة، انتظر قليلًا.');
    const o = findAuthorised(ctx, ctx.params.number);
    if (!o.payment_method.startsWith('online') || !onlineMethods().some((m) => m.id === gatewayIdOf(o))) throw new HttpError(400, 'not_online', 'الدفع الإلكتروني غير متاح لهذا الطلب حاليًا');
    if (o.payment_status === 'paid') throw new HttpError(409, 'already_paid', 'تم دفع هذا الطلب بالفعل');
    if (o.status === 'cancelled') throw new HttpError(409, 'cancelled', 'الطلب ملغي');
    try { return { redirectUrl: (await startPayment(o)).redirectUrl }; }
    catch { throw new HttpError(502, 'payment_unavailable', 'تعذّر بدء الدفع الآن. حاول لاحقًا.'); }
  });

  // Gateway → us. The raw body is needed for signature verification. :id is the gateway id shown in the admin panel.
  r.post('/api/payments/webhook/:id', async (ctx) => {
    const raw = await readBody(ctx.req, 64 * 1024);
    const out = handleWebhook(Number(ctx.params.id), raw, ctx.req.headers);
    ctx.status = out.status;
    return out.body;
  });
}

/** Non-/api routes: payment return + sandbox hosted page. Handled directly (they redirect / render HTML). */
export async function pageRoutes(req, res, url, ctx) {
  // Customer returns from the gateway: /pay/return/<number>/<token>  (legacy: ?t=<token>)
  const m = /^\/pay\/return\/([^/]+)(?:\/([a-f0-9]+))?\/?$/.exec(url.pathname);
  if (m && req.method === 'GET') {
    const number = decodeURIComponent(m[1]);
    const o = get('SELECT * FROM orders WHERE number = ?', number);
    const t = m[2] || url.searchParams.get('t') || '';
    if (!o || !tokenEq(t, o.public_token)) { redirect(res, '/'); return true; }
    await handleReturn(o, Object.fromEntries(url.searchParams)); // signed query or server-side lookup — never the browser's word
    redirect(res, `/order/${encodeURIComponent(o.number)}?t=${o.public_token}`);
    return true;
  }

  const sb = TYPES.sandbox ? /^\/sandbox\/pay\/(sbx_[a-f0-9]+)(?:\/(paid|failed|cancelled))?\/?$/.exec(url.pathname) : null;
  if (sb) {
    const prov = TYPES.sandbox; const ref = sb[1];
    const pay = get('SELECT p.*, o.number, o.public_token FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.provider = ? AND p.provider_ref = ?', 'sandbox', ref);
    if (!pay) { send(res, 404, 'not found', { 'Content-Type': 'text/plain' }); return true; }
    if (req.method === 'POST' && sb[2]) {
      await readBody(req, 1024);
      if (!rateLimit(`sbx:${ctx.ip}`, 30, 60_000)) { send(res, 429, 'slow down'); return true; }
      const g = prov._gateway.get(ref); if (g && g.status === 'pending') g.status = sb[2];
      const ev = prov._signedEvent(ref, sb[2]);
      handleWebhook(pay.gateway_id, Buffer.from(ev.body), { 'x-signature': ev.signature }); // what a real gateway's server would POST to us
      handleWebhook(pay.gateway_id, Buffer.from(ev.body), { 'x-signature': ev.signature }); // duplicate delivery must be a no-op
      redirect(res, `/pay/return/${encodeURIComponent(pay.number)}/${pay.public_token}`, 303);
      return true;
    }
    const html = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>بوابة الدفع التجريبية</title>
<style>body{font-family:Cairo,system-ui,sans-serif;background:#faf8f6;color:#2b0713;display:grid;place-items:center;min-height:100vh;margin:0}
.c{background:#fff;border:1px solid #e8dcd2;border-radius:16px;padding:28px;max-width:420px;width:92%;text-align:center}
.t{background:#fff3cd;color:#664d03;border-radius:8px;padding:8px;font-size:14px;margin-bottom:16px}
button{font:inherit;display:block;width:100%;margin:8px 0;padding:12px;border-radius:10px;border:0;cursor:pointer;font-weight:700}
.ok{background:#1f7a3d;color:#fff}.no{background:#b3261e;color:#fff}.ca{background:#eee}</style>
<div class="c"><div class="t">بيئة اختبار — لا يوجد خصم حقيقي</div>
<h2>طلب ${pay.number}</h2><p>المبلغ: ${(pay.amount / 1000).toFixed(3)} د.ل</p>
<form method="post" action="/sandbox/pay/${ref}/paid"><button class="ok">محاكاة نجاح الدفع</button></form>
<form method="post" action="/sandbox/pay/${ref}/failed"><button class="no">محاكاة فشل الدفع</button></form>
<form method="post" action="/sandbox/pay/${ref}/cancelled"><button class="ca">إلغاء الدفع</button></form></div></html>`;
    send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return true;
  }
  return false;
}
