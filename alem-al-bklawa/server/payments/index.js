// Payment orchestration — provider-agnostic, server-verified, idempotent.
//
//  • No card data ever touches this server (hosted payment page at the provider).
//  • The browser's "I paid" is never trusted: status comes from the provider's webhook or a
//    server-to-server status lookup, and the amount must equal the order total.
//  • Every state change is idempotent (duplicate webhooks / double returns are no-ops).
//
// A provider is a module in ./providers/<name>.js exporting a default object:
//   { id, label, createPayment({order, payment, returnUrl, webhookUrl}) → {providerRef, redirectUrl, raw?},
//     fetchStatus({payment}) → {status:'paid'|'failed'|'cancelled'|'pending', amount?, raw?},
//     parseWebhook({rawBody, headers, secret}) → {eventId, providerRef, status, amount?, raw?}  (throws if signature invalid) }
// See docs/PAYMENTS.md.
import { config } from '../config.js';
import { all, get, run, tx, nowIso } from '../db.js';
import { getSettings } from '../settings.js';

let provider = null;
let loadError = null;

export async function loadProvider() {
  provider = null; loadError = null;
  if (config.payment.sandboxRequestedInProd) console.warn('[payments] PAYMENT_SANDBOX تجاهل: بوابة الاختبار ممنوعة في الإنتاج.');
  try {
    if (config.payment.provider) {
      if (!/^[a-z0-9-]+$/.test(config.payment.provider)) throw new Error('bad provider name');
      provider = (await import(`./providers/${config.payment.provider}.js`)).default;
      if (!config.payment.webhookSecret) console.warn('[payments] PAYMENT_WEBHOOK_SECRET غير مضبوط: لن تُقبل إشعارات الدفع.');
    } else if (config.payment.sandbox) {
      provider = (await import('./providers/sandbox.js')).default;
    }
  } catch (e) {
    loadError = e.message;
    console.error('[payments] تعذر تحميل مزود الدفع:', e.message);
  }
}

export const getProvider = () => provider;

/** Online methods shown at checkout. Empty unless a provider is loaded AND the owner enabled it. */
export function onlineMethods() {
  if (!provider || !getSettings().online_payment_enabled) return [];
  return [{ id: 'online', label: provider.label, sandbox: provider.id === 'sandbox' }];
}
export const paymentStatus = () => ({
  provider: provider?.id || null, sandbox: provider?.id === 'sandbox', error: loadError,
  webhookConfigured: !!config.payment.webhookSecret || provider?.id === 'sandbox',
});

const returnUrlFor = (o) => `${config.siteUrl}/pay/return/${encodeURIComponent(o.number)}?t=${o.public_token}`;
const webhookUrl = () => `${config.siteUrl}/api/payments/webhook/${provider.id}`;

/** Create (or reuse) a pending payment for the order and return where to send the customer. */
export async function startPayment(order) {
  if (!provider) throw new Error('no_provider');
  const existing = get(
    `SELECT * FROM payments WHERE order_id = ? AND status = 'pending' AND redirect_url IS NOT NULL ORDER BY id DESC LIMIT 1`, order.id);
  if (existing && Date.now() - Date.parse(existing.created_at) < 25 * 60_000) return { payment: existing, redirectUrl: existing.redirect_url };

  const attempt = get('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', order.id).n + 1;
  const idem = `abk-${order.number}-${attempt}`;
  const info = run(
    `INSERT INTO payments (order_id, provider, amount, currency, status, idempotency_key) VALUES (?, ?, ?, ?, 'pending', ?)`,
    order.id, provider.id, order.total, order.currency, idem);
  const payment = get('SELECT * FROM payments WHERE id = ?', Number(info.lastInsertRowid));
  try {
    const res = await provider.createPayment({ order, payment, returnUrl: returnUrlFor(order), webhookUrl: webhookUrl() });
    run('UPDATE payments SET provider_ref = ?, redirect_url = ?, raw = ?, updated_at = ? WHERE id = ?',
      res.providerRef, res.redirectUrl, res.raw ? JSON.stringify(res.raw).slice(0, 2000) : null, nowIso(), payment.id);
    tx(() => {
      run("UPDATE orders SET payment_status = 'pending', updated_at = ? WHERE id = ? AND payment_status != 'paid'", nowIso(), order.id);
      run("INSERT INTO order_events (order_id, kind, to_value, note) VALUES (?, 'payment', 'pending', ?)", order.id, 'بدء الدفع الإلكتروني');
    });
    return { payment: get('SELECT * FROM payments WHERE id = ?', payment.id), redirectUrl: res.redirectUrl };
  } catch (e) {
    run("UPDATE payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", String(e.message).slice(0, 300), nowIso(), payment.id);
    run("UPDATE orders SET payment_status = 'failed', updated_at = ? WHERE id = ? AND payment_status != 'paid'", nowIso(), order.id);
    throw e;
  }
}

const TO_ORDER = { paid: 'paid', failed: 'failed', cancelled: 'cancelled', pending: 'pending' };

/** Idempotently apply a provider-reported result to a payment + its order. Returns what happened. */
export function applyResult(paymentId, { status, amount, raw }, by = 'provider') {
  return tx(() => {
    const pay = get('SELECT * FROM payments WHERE id = ?', paymentId);
    if (!pay) return { changed: false, reason: 'unknown_payment' };
    const order = get('SELECT * FROM orders WHERE id = ?', pay.order_id);
    if (pay.status === status) return { changed: false, reason: 'already_applied', payment: pay, order };
    if (pay.status === 'paid' && status !== 'refunded') return { changed: false, reason: 'already_paid', payment: pay, order };

    let finalStatus = status; let note = null;
    if (status === 'paid') {
      if (amount !== undefined && amount !== null && Number(amount) !== pay.amount) {
        finalStatus = 'failed'; note = 'مبلغ الدفع لا يطابق إجمالي الطلب — تحتاج مراجعة يدوية';
      } else if (pay.amount !== order.total) {
        finalStatus = 'failed'; note = 'تغيّر إجمالي الطلب بعد بدء الدفع — تحتاج مراجعة يدوية';
      }
    }
    run('UPDATE payments SET status = ?, failure_reason = ?, raw = COALESCE(?, raw), updated_at = ? WHERE id = ?',
      finalStatus, note, raw ? JSON.stringify(raw).slice(0, 2000) : null, nowIso(), pay.id);

    const prevOrderPay = order.payment_status;
    if (finalStatus === 'paid') {
      run("UPDATE orders SET payment_status = 'paid', updated_at = ? WHERE id = ?", nowIso(), order.id);
      run("INSERT INTO order_events (order_id, kind, from_value, to_value, note) VALUES (?, 'payment', ?, 'paid', ?)",
        order.id, prevOrderPay, prevOrderPay === 'paid' ? 'دفعة مكررة وصلت لنفس الطلب — راجعها مع مزود الدفع' : `تأكيد الدفع من المزود (${by})`);
    } else if (prevOrderPay !== 'paid') {
      run('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?', TO_ORDER[finalStatus] || 'failed', nowIso(), order.id);
      run("INSERT INTO order_events (order_id, kind, from_value, to_value, note) VALUES (?, 'payment', ?, ?, ?)",
        order.id, prevOrderPay, TO_ORDER[finalStatus] || 'failed', note);
    }
    return { changed: true, payment: get('SELECT * FROM payments WHERE id = ?', pay.id), order: get('SELECT * FROM orders WHERE id = ?', order.id) };
  });
}

/** Ask the provider server-to-server (never trust the browser) and apply. */
export async function verifyPayment(order) {
  if (!provider) return null;
  const pay = get("SELECT * FROM payments WHERE order_id = ? AND provider = ? ORDER BY id DESC LIMIT 1", order.id, provider.id);
  if (!pay || pay.status === 'paid') return pay;
  try {
    const r = await provider.fetchStatus({ payment: pay });
    if (r && r.status && r.status !== 'pending') applyResult(pay.id, r, 'verify');
  } catch (e) { console.error('[payments] verify failed:', e.message); }
  return get('SELECT * FROM payments WHERE id = ?', pay.id);
}

/** Webhook entry point. Verifies the signature, de-duplicates by event id, applies idempotently. */
export function handleWebhook(rawBody, headers) {
  if (!provider) return { status: 404, body: { error: 'no_provider' } };
  let ev;
  try { ev = provider.parseWebhook({ rawBody, headers, secret: config.payment.webhookSecret || provider.devSecret }); }
  catch { return { status: 401, body: { error: 'invalid_signature' } }; }
  if (!ev?.eventId || !ev?.providerRef) return { status: 400, body: { error: 'bad_event' } };
  const fresh = run('INSERT OR IGNORE INTO webhook_events (provider, event_id) VALUES (?, ?)', provider.id, String(ev.eventId)).changes === 1;
  if (!fresh) return { status: 200, body: { ok: true, duplicate: true } };
  const pay = get('SELECT id FROM payments WHERE provider = ? AND provider_ref = ?', provider.id, String(ev.providerRef));
  if (!pay) return { status: 202, body: { ok: true, ignored: 'unknown_reference' } };
  const r = applyResult(pay.id, ev, 'webhook');
  return { status: 200, body: { ok: true, changed: r.changed } };
}

export const paymentsForOrder = (orderId) =>
  all('SELECT id, provider, provider_ref, amount, currency, status, failure_reason, created_at, updated_at FROM payments WHERE order_id = ? ORDER BY id DESC', orderId);
