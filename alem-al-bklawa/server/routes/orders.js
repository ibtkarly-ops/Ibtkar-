// Orders (create / view / track) and the payment endpoints (return URL, webhook, sandbox gateway page).
import crypto from 'node:crypto';
import { rt, db } from '../runtime.js';
import { getSettings } from '../settings.js';
import { priceCart } from '../pricing.js';
import { HttpError, str, int, normalizePhone, emailOrEmpty, bad, ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from '../lib.js';
import { rateLimit, readBody, redirectResponse, textResponse, randomHex, originOf } from '../http.js';
import { onlineMethods, startPayment, handleReturn, handleWebhook, gatewayIdOf } from '../payments/index.js';
import { types } from '../payments/registry.js';

// ── Reads: one query returns the order, its branch contact and the item count ──
const ORDER_SELECT = `SELECT o.*, b.id AS b_id, b.name AS b_name, b.address AS b_address, b.phone AS b_phone, b.whatsapp AS b_whatsapp,
       b.maps_url AS b_maps_url, b.hours AS b_hours,
       (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = o.id) AS item_count
  FROM orders o LEFT JOIN branches b ON b.id = o.branch_id`;
export const selectOrders = (where = '', params = [], tail = '') => db.all(`${ORDER_SELECT} ${where} ${tail}`, ...params);
export const selectOrder = async (where, params) => (await selectOrders(`WHERE ${where}`, params, 'LIMIT 1'))[0];

/** Public/owner view of an order. `o` comes from selectOrder(s). */
export async function orderView(o, { withItems = true, withEvents = false } = {}) {
  const v = {
    number: o.number, status: o.status, status_label: ORDER_STATUS_LABELS[o.status],
    payment_method: o.payment_method, payment_status: o.payment_status, payment_status_label: PAYMENT_STATUS_LABELS[o.payment_status],
    fulfillment: o.fulfillment, address: o.address, notes: o.notes, source: o.source,
    subtotal: o.subtotal, delivery_fee: o.delivery_fee, total: o.total, currency: o.currency,
    customer_name: o.customer_name, customer_phone: o.customer_phone,
    branch: o.b_id ? { id: o.b_id, name: o.b_name, address: o.b_address, phone: o.b_phone, whatsapp: o.b_whatsapp, maps_url: o.b_maps_url, hours: o.b_hours } : { name: o.branch_name },
    created_at: o.created_at, updated_at: o.updated_at,
  };
  if (o.item_count !== undefined) v.item_count = Number(o.item_count);
  if (withItems || withEvents) {
    const stmts = [];
    if (withItems) stmts.push(['SELECT kind, name, variant_name, unit_price, quantity, line_total, note FROM order_items WHERE order_id = ? ORDER BY id', o.id]);
    if (withEvents) stmts.push(['SELECT kind, from_value, to_value, note, created_at FROM order_events WHERE order_id = ? ORDER BY id', o.id]);
    const res = await db.batch(stmts); let i = 0;
    if (withItems) v.items = res[i++].rows;
    if (withEvents) v.events = res[i++].rows;
  }
  return v;
}
export const orderListView = (rows) => Promise.all(rows.map((o) => orderView(o, { withItems: false })));

const tokenEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function findAuthorised(ctx, number) {
  const o = await selectOrder('o.number = ?', [number]);
  if (!o) throw new HttpError(404, 'not_found', 'الطلب غير موجود');
  const t = ctx.query.get('t') || '';
  const owner = ctx.user && o.user_id === ctx.user.id;
  const staff = ctx.user && (ctx.user.role === 'admin' || ctx.user.role === 'staff');
  if (!(owner || staff || (t && tokenEq(t, o.public_token)))) throw new HttpError(404, 'not_found', 'الطلب غير موجود');
  return o;
}

// ── Create ─────────────────────────────────────────────────────────────────
async function createOrder(ctx) {
  if (!(await rateLimit(`order:${ctx.ip}`, rt.config.orderRateMax, 10 * 60_000))) throw new HttpError(429, 'rate_limited', 'طلبات كثيرة، انتظر قليلًا ثم أعد المحاولة.');
  const b = await ctx.json(16 * 1024);
  const settings = await getSettings();

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
  const branch = await db.get('SELECT * FROM branches WHERE id = ? AND active = 1', branchId);
  if (!branch || !branch.accepts_orders) throw bad('invalid_branch', 'الفرع المختار لا يستقبل الطلبات حاليًا', { field: 'branchId' });

  let method = 'cash';
  if (source !== 'whatsapp' && typeof b.paymentMethod === 'string' && b.paymentMethod.startsWith('online:')) {
    const gid = Number(b.paymentMethod.slice(7));
    if (!(await onlineMethods()).some((m) => m.id === gid)) throw bad('payment_unavailable', 'طريقة الدفع الإلكتروني غير متاحة حاليًا', { field: 'paymentMethod' });
    method = `online:${gid}`;
  }
  if (method === 'cash' && !settings.cash_enabled) throw bad('payment_unavailable', 'طريقة الدفع غير متاحة', { field: 'paymentMethod' });

  // Duplicate submit / retry → return the original order untouched.
  const existing = async () => {
    const dup = await selectOrder('o.idempotency_key = ?', [idem]);
    return dup ? { duplicate: true, order: await orderView(dup), token: dup.public_token, redirectUrl: null } : null;
  };
  const dup = await existing(); if (dup) return dup;

  const pricing = await priceCart(b.items, { fulfillment, branchId });
  if (!pricing.ok) throw new HttpError(422, 'cart_invalid', 'بعض الأصناف في سلتك لم تعد متاحة', { pricing });
  if (b.expectedTotal !== undefined && b.expectedTotal !== null && Number(b.expectedTotal) !== pricing.total) {
    throw new HttpError(409, 'price_changed', 'تغيّر السعر منذ آخر عرض. راجع الإجمالي الجديد قبل التأكيد.', { pricing });
  }

  // One atomic batch: order, its number (ABK-<1000+id>), items and the first history event. Rows are linked by the
  // random public token, so nothing depends on knowing the new id in advance.
  const token = randomHex(16);
  const stmts = [
    [`INSERT INTO orders (number, public_token, user_id, customer_name, customer_phone, customer_email, branch_id, branch_name,
                          fulfillment, address, notes, subtotal, delivery_fee, total, currency, payment_method, payment_status,
                          status, source, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', 'new', ?, ?)`,
    'TMP-' + randomHex(6), token, ctx.user?.id ?? null, name, phone, email || null, branch.id, branch.name,
    fulfillment, address || null, notes || null, pricing.subtotal, pricing.deliveryFee, pricing.total, settings.currency, method, source, idem],
    ["UPDATE orders SET number = 'ABK-' || (1000 + id) WHERE public_token = ?", token],
    ...pricing.lines.map((l) => [
      `INSERT INTO order_items (order_id, kind, product_id, variant_id, bundle_id, name, variant_name, unit_price, quantity, line_total, note)
       SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM orders WHERE public_token = ?`,
      l.type, l.type === 'product' ? l.id : null, l.variantId, l.type === 'bundle' ? l.id : null, l.name, l.variantName, l.unitPrice, l.qty, l.lineTotal, l.note || null, token]),
    [`INSERT INTO order_events (order_id, kind, to_value, note, user_id) SELECT id, 'created', 'new', ?, ? FROM orders WHERE public_token = ?`,
      source === 'whatsapp' ? 'طلب مسجّل من الموقع (باقة عبر واتساب)' : 'طلب جديد من الموقع', ctx.user?.id ?? null, token],
  ];
  try { await db.batch(stmts); }
  catch (e) { // a concurrent submit with the same idempotency key won the race → return that order
    if (/UNIQUE|constraint/i.test(String(e.message))) { const again = await existing(); if (again) return again; }
    throw e;
  }
  const order = await selectOrder('o.public_token = ?', [token]);

  let redirectUrl = null; let paymentError = null;
  if (method.startsWith('online:')) {
    try { redirectUrl = (await startPayment(order, originOf(ctx.request))).redirectUrl; }
    catch (e) { console.error('[orders] payment start failed:', e.message); paymentError = 'تعذّر بدء الدفع الإلكتروني. تم حفظ طلبك ويمكنك إعادة المحاولة من صفحة الطلب.'; }
  }
  return { duplicate: false, order: await orderView(await selectOrder('o.id = ?', [order.id])), token, redirectUrl, paymentError };
}

const sandboxPage = (pay, ref) => `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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

export function register(r) {
  r.post('/api/orders', createOrder);

  r.get('/api/orders/:number', async (ctx) => {
    const o = await findAuthorised(ctx, ctx.params.number);
    return { order: await orderView(o, { withEvents: true }), token: o.public_token };
  });

  // Guest tracking: order number + the phone used for the order.
  r.post('/api/orders/lookup', async (ctx) => {
    if (!(await rateLimit(`lookup:${ctx.ip}`, 10, 10 * 60_000))) throw new HttpError(429, 'rate_limited', 'محاولات كثيرة، انتظر قليلًا.');
    const b = await ctx.json();
    const number = str(b.number, { max: 30, required: true, field: 'number' }).toUpperCase();
    const phone = normalizePhone(b.phone);
    const o = await selectOrder('o.number = ?', [number]);
    if (!o || !phone || o.customer_phone !== phone) throw new HttpError(404, 'not_found', 'لم نجد طلبًا بهذه البيانات');
    return { order: await orderView(o, { withEvents: true }), token: o.public_token };
  });

  // (Re)start online payment for an unpaid order.
  r.post('/api/orders/:number/pay', async (ctx) => {
    if (!(await rateLimit(`pay:${ctx.ip}`, 10, 10 * 60_000))) throw new HttpError(429, 'rate_limited', 'محاولات كثيرة، انتظر قليلًا.');
    const o = await findAuthorised(ctx, ctx.params.number);
    if (!o.payment_method.startsWith('online') || !(await onlineMethods()).some((m) => m.id === gatewayIdOf(o))) throw new HttpError(400, 'not_online', 'الدفع الإلكتروني غير متاح لهذا الطلب حاليًا');
    if (o.payment_status === 'paid') throw new HttpError(409, 'already_paid', 'تم دفع هذا الطلب بالفعل');
    if (o.status === 'cancelled') throw new HttpError(409, 'cancelled', 'الطلب ملغي');
    try { return { redirectUrl: (await startPayment(o, originOf(ctx.request))).redirectUrl }; }
    catch { throw new HttpError(502, 'payment_unavailable', 'تعذّر بدء الدفع الآن. حاول لاحقًا.'); }
  });

  // Gateway → us. The raw body is needed for signature verification. :id is the gateway id shown in the admin panel.
  r.post('/api/payments/webhook/:id', async (ctx) => {
    const raw = await readBody(ctx.request, 64 * 1024);
    const out = await handleWebhook(Number(ctx.params.id), raw, ctx.request.headers);
    ctx.status = out.status;
    return out.body;
  });

  // ── Pages (redirect / HTML), not JSON ──
  // Customer returns from the gateway: /pay/return/<number>/<token>  (legacy: ?t=<token>)
  const payReturn = async (ctx) => {
    const o = await selectOrder('o.number = ?', [ctx.params.number]);
    const t = ctx.params.token || ctx.query.get('t') || '';
    if (!o || !tokenEq(t, o.public_token)) return redirectResponse('/');
    await handleReturn(o, Object.fromEntries(ctx.query)); // signed query or server-side lookup — never the browser's word
    return redirectResponse(`/order/${encodeURIComponent(o.number)}?t=${o.public_token}`);
  };
  r.get('/pay/return/:number', payReturn);
  r.get('/pay/return/:number/:token', payReturn);

  // Sandbox hosted page (test double; exists only outside production).
  const sandboxPay = async (ref) => db.get('SELECT p.*, o.number, o.public_token FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.provider = ? AND p.provider_ref = ?', 'sandbox', ref);
  r.get('/sandbox/pay/:ref', async (ctx) => {
    const sb = types().sandbox; const pay = sb && /^sbx_[a-f0-9]+$/.test(ctx.params.ref) ? await sandboxPay(ctx.params.ref) : null;
    if (!pay) return textResponse(404, 'not found');
    return textResponse(200, sandboxPage(pay, ctx.params.ref), 'text/html; charset=utf-8', { 'cache-control': 'no-store' });
  });
  r.post('/sandbox/pay/:ref/:outcome', async (ctx) => {
    const sb = types().sandbox; const { ref, outcome } = ctx.params;
    const pay = sb && /^sbx_[a-f0-9]+$/.test(ref) && ['paid', 'failed', 'cancelled'].includes(outcome) ? await sandboxPay(ref) : null;
    if (!pay) return textResponse(404, 'not found');
    if (!(await rateLimit(`sbx:${ctx.ip}`, 30, 60_000))) return textResponse(429, 'slow down');
    await sb._setStatus(ref, outcome);
    const ev = await sb._signedEvent(ref, outcome);
    const hdrs = new Headers({ 'x-signature': ev.signature });
    await handleWebhook(pay.gateway_id, Buffer.from(ev.body), hdrs); // what a real gateway's server would POST to us
    await handleWebhook(pay.gateway_id, Buffer.from(ev.body), hdrs); // duplicate delivery must be a no-op
    return redirectResponse(`/pay/return/${encodeURIComponent(pay.number)}/${pay.public_token}`, 303);
  });
}
