// Payment orchestration — gateway-agnostic, server-verified, idempotent.
//
//  • Gateways are configured from the admin panel (table payment_gateways; secrets encrypted by vault.js).
//  • No card data ever touches this server (hosted payment page at the gateway).
//  • The browser's "I paid" is never trusted: status comes from a signed webhook / signed return query, or a
//    server-to-server status lookup, and the amount must equal the order total.
//  • Every state change is idempotent (duplicate webhooks / double returns are no-ops).
import { config } from '../config.js';
import { all, get, run, tx, nowIso } from '../db.js';
import { unseal } from '../vault.js';
import { TYPES } from './registry.js';

function hydrate(row) {
  const adapter = TYPES[row.type];
  if (!adapter) return null;
  let cfg = {}; try { cfg = JSON.parse(row.config || '{}'); } catch { /* empty */ }
  return { id: row.id, type: row.type, label: row.label, mode: row.mode, enabled: !!row.enabled, config: cfg, secrets: unseal(row.secrets), adapter };
}
export const getGateway = (id) => { const r = get('SELECT * FROM payment_gateways WHERE id = ?', Number(id)); return r ? hydrate(r) : null; };

/** Online methods shown at checkout: enabled gateways whose type is available in this environment. */
export function onlineMethods() {
  return all('SELECT * FROM payment_gateways WHERE enabled = 1 ORDER BY sort_order, id').filter((r) => TYPES[r.type])
    .map((r) => ({ id: r.id, label: r.label, sandbox: r.type === 'sandbox' }));
}
export const gatewayIdOf = (order) => { const m = /^online:(\d+)$/.exec(order.payment_method || ''); return m ? Number(m[1]) : null; };

const base = () => config.siteUrl;
const returnUrlFor = (o) => `${base()}/pay/return/${encodeURIComponent(o.number)}/${o.public_token}`;
const webhookUrlFor = (gw) => `${base()}/api/payments/webhook/${gw.id}`;
export const webhookUrlForId = (id) => `${base()}/api/payments/webhook/${id}`;

/** Create (or reuse) a pending payment for the order and return where to send the customer. */
export async function startPayment(order) {
  const gw = getGateway(gatewayIdOf(order));
  if (!gw || !gw.enabled) throw new Error('gateway_unavailable');
  const existing = get(`SELECT * FROM payments WHERE order_id = ? AND gateway_id = ? AND status = 'pending' AND redirect_url IS NOT NULL ORDER BY id DESC LIMIT 1`, order.id, gw.id);
  if (existing && Date.now() - Date.parse(existing.created_at) < 25 * 60_000) return { payment: existing, redirectUrl: existing.redirect_url };

  const attempt = get('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', order.id).n + 1;
  const idem = `${order.number}-${attempt}`;
  const info = run(`INSERT INTO payments (order_id, provider, gateway_id, amount, currency, status, idempotency_key) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    order.id, gw.type, gw.id, order.total, order.currency, idem);
  const payment = get('SELECT * FROM payments WHERE id = ?', Number(info.lastInsertRowid));
  try {
    const url = returnUrlFor(order);
    const res = await gw.adapter.createPayment({ gateway: gw, order, payment, returnUrl: url, cancelUrl: url, webhookUrl: webhookUrlFor(gw) });
    run('UPDATE payments SET provider_ref = ?, redirect_url = ?, raw = ?, updated_at = ? WHERE id = ?',
      res.providerRef ?? null, res.redirectUrl, res.raw ? JSON.stringify(res.raw).slice(0, 2000) : null, nowIso(), payment.id);
    tx(() => {
      run("UPDATE orders SET payment_status = 'pending', updated_at = ? WHERE id = ? AND payment_status != 'paid'", nowIso(), order.id);
      run("INSERT INTO order_events (order_id, kind, to_value, note) VALUES (?, 'payment', 'pending', ?)", order.id, `بدء الدفع الإلكتروني (${gw.label})`);
    });
    return { payment: get('SELECT * FROM payments WHERE id = ?', payment.id), redirectUrl: res.redirectUrl };
  } catch (e) {
    run("UPDATE payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", String(e.message).slice(0, 300), nowIso(), payment.id);
    run("UPDATE orders SET payment_status = 'failed', updated_at = ? WHERE id = ? AND payment_status != 'paid'", nowIso(), order.id);
    throw e;
  }
}

/** Idempotently apply a gateway-reported result to a payment + its order. */
export function applyResult(paymentId, { status, amount, raw }, by = 'gateway') {
  return tx(() => {
    const pay = get('SELECT * FROM payments WHERE id = ?', paymentId);
    if (!pay) return { changed: false, reason: 'unknown_payment' };
    const order = get('SELECT * FROM orders WHERE id = ?', pay.order_id);
    if (pay.status === status) return { changed: false, reason: 'already_applied', payment: pay, order };
    if (pay.status === 'paid' && status !== 'refunded') return { changed: false, reason: 'already_paid', payment: pay, order };

    let finalStatus = status; let note = null;
    if (status === 'paid') {
      if (amount !== undefined && amount !== null && Number(amount) !== pay.amount) { finalStatus = 'failed'; note = 'مبلغ الدفع لا يطابق إجمالي الطلب — تحتاج مراجعة يدوية'; }
      else if (pay.amount !== order.total) { finalStatus = 'failed'; note = 'تغيّر إجمالي الطلب بعد بدء الدفع — تحتاج مراجعة يدوية'; }
    }
    run('UPDATE payments SET status = ?, failure_reason = ?, raw = COALESCE(?, raw), updated_at = ? WHERE id = ?',
      finalStatus, note, raw ? JSON.stringify(raw).slice(0, 2000) : null, nowIso(), pay.id);

    const prev = order.payment_status;
    if (finalStatus === 'paid') {
      run("UPDATE orders SET payment_status = 'paid', updated_at = ? WHERE id = ?", nowIso(), order.id);
      run("INSERT INTO order_events (order_id, kind, from_value, to_value, note) VALUES (?, 'payment', ?, 'paid', ?)", order.id, prev,
        prev === 'paid' ? 'دفعة مكررة وصلت لنفس الطلب — راجعها مع مزود الدفع' : `تأكيد الدفع من البوابة (${by})`);
    } else if (prev !== 'paid') {
      run('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?', finalStatus, nowIso(), order.id);
      run("INSERT INTO order_events (order_id, kind, from_value, to_value, note) VALUES (?, 'payment', ?, ?, ?)", order.id, prev, finalStatus, note);
    }
    return { changed: true, payment: get('SELECT * FROM payments WHERE id = ?', pay.id), order: get('SELECT * FROM orders WHERE id = ?', order.id) };
  });
}

const findPayment = (gwId, ev) =>
  (ev.providerRef && get('SELECT id FROM payments WHERE gateway_id = ? AND provider_ref = ?', gwId, String(ev.providerRef)))
  || (ev.paymentRef && get('SELECT id FROM payments WHERE gateway_id = ? AND idempotency_key = ?', gwId, String(ev.paymentRef)))
  || null;

/** Customer came back from the gateway. Only a signed return query or a server-side lookup can change anything. */
export async function handleReturn(order, query) {
  const pay = get('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1', order.id);
  if (!pay || pay.status === 'paid' || !pay.gateway_id) return pay;
  const gw = getGateway(pay.gateway_id); if (!gw) return pay;
  try {
    if (gw.adapter.parseReturn && query && Object.keys(query).length) {
      const ev = gw.adapter.parseReturn({ query, gateway: gw });
      const target = findPayment(gw.id, ev); if (target) applyResult(target.id, ev, 'return');
    } else if (gw.adapter.fetchStatus) {
      const r = await gw.adapter.fetchStatus({ gateway: gw, payment: pay });
      if (r?.status && r.status !== 'pending') applyResult(pay.id, r, 'verify');
    }
  } catch (e) { console.error('[payments] return handling failed:', e.message); }
  return get('SELECT * FROM payments WHERE id = ?', pay.id);
}

/** Webhook entry point: verify signature → de-duplicate by event id → apply idempotently. */
export function handleWebhook(gatewayId, rawBody, headers) {
  const gw = getGateway(gatewayId);
  if (!gw) return { status: 404, body: { error: 'unknown_gateway' } };
  let ev;
  try { ev = gw.adapter.parseWebhook({ rawBody, headers, gateway: gw }); }
  catch { return { status: 401, body: { error: 'invalid_signature' } }; }
  if (!ev?.eventId || (!ev.providerRef && !ev.paymentRef)) return { status: 400, body: { error: 'bad_event' } };
  const fresh = run('INSERT OR IGNORE INTO webhook_events (provider, event_id) VALUES (?, ?)', `gw${gw.id}`, String(ev.eventId)).changes === 1;
  if (!fresh) return { status: 200, body: { ok: true, duplicate: true } };
  const pay = findPayment(gw.id, ev);
  if (!pay) return { status: 202, body: { ok: true, ignored: 'unknown_reference' } };
  const r = applyResult(pay.id, ev, 'webhook');
  return { status: 200, body: { ok: true, changed: r.changed } };
}

export const paymentsForOrder = (orderId) =>
  all('SELECT id, provider, gateway_id, provider_ref, amount, currency, status, failure_reason, created_at, updated_at FROM payments WHERE order_id = ? ORDER BY id DESC', orderId);
export const gatewaySummary = () => ({ enabled: get('SELECT COUNT(*) AS n FROM payment_gateways WHERE enabled = 1').n });
