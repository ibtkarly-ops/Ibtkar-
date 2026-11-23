// Payment orchestration — gateway-agnostic, server-verified, idempotent.
//
//  • Gateways are configured from the admin panel (table payment_gateways; secrets encrypted by vault.js).
//  • No card data ever touches this server (hosted payment page at the gateway).
//  • The browser's "I paid" is never trusted: status comes from a signed webhook / signed return query, or a
//    server-to-server status lookup, and the amount must equal the order total.
//  • Every state change is idempotent (duplicate webhooks / double returns are no-ops).
import { rt } from '../runtime.js';
import { nowIso } from '../dbutil.js';
import { unseal } from '../vault.js';
import { types } from './registry.js';

async function hydrate(row) {
  const adapter = types()[row.type];
  if (!adapter) return null;
  let cfg = {}; try { cfg = JSON.parse(row.config || '{}'); } catch { /* empty */ }
  return { id: row.id, type: row.type, label: row.label, mode: row.mode, enabled: !!row.enabled, config: cfg, secrets: await unseal(row.secrets), adapter };
}
export async function getGateway(id) {
  const r = await rt.db.get('SELECT * FROM payment_gateways WHERE id = ?', Number(id));
  return r ? hydrate(r) : null;
}

/** Online methods shown at checkout: enabled gateways whose type is available in this environment. */
export async function onlineMethods() {
  const t = types();
  return (await rt.db.all('SELECT * FROM payment_gateways WHERE enabled = 1 ORDER BY sort_order, id')).filter((r) => t[r.type])
    .map((r) => ({ id: r.id, label: r.label, sandbox: r.type === 'sandbox' }));
}
export const gatewayIdOf = (order) => { const m = /^online:(\d+)$/.exec(order.payment_method || ''); return m ? Number(m[1]) : null; };

const returnUrlFor = (origin, o) => `${origin}/pay/return/${encodeURIComponent(o.number)}/${o.public_token}`;
export const webhookUrlForId = (origin, id) => `${origin}/api/payments/webhook/${id}`;

/** Create (or reuse) a pending payment for the order and return where to send the customer. */
export async function startPayment(order, origin) {
  const { db } = rt;
  const gw = await getGateway(gatewayIdOf(order));
  if (!gw || !gw.enabled) throw new Error('gateway_unavailable');
  const existing = await db.get(`SELECT * FROM payments WHERE order_id = ? AND gateway_id = ? AND status = 'pending' AND redirect_url IS NOT NULL ORDER BY id DESC LIMIT 1`, order.id, gw.id);
  if (existing && Date.now() - Date.parse(existing.created_at) < 25 * 60_000) return { payment: existing, redirectUrl: existing.redirect_url };

  const attempt = (await db.get('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', order.id)).n + 1;
  const idem = `${order.number}-${attempt}`;
  const info = await db.run(`INSERT INTO payments (order_id, provider, gateway_id, amount, currency, status, idempotency_key) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    order.id, gw.type, gw.id, order.total, order.currency, idem);
  const payment = await db.get('SELECT * FROM payments WHERE id = ?', info.lastInsertRowid);
  try {
    const url = returnUrlFor(origin, order);
    const res = await gw.adapter.createPayment({ gateway: gw, order, payment, returnUrl: url, cancelUrl: url, webhookUrl: webhookUrlForId(origin, gw.id) });
    await db.batch([
      ['UPDATE payments SET provider_ref = ?, redirect_url = ?, raw = ?, updated_at = ? WHERE id = ?', res.providerRef ?? null, res.redirectUrl, res.raw ? JSON.stringify(res.raw).slice(0, 2000) : null, nowIso(), payment.id],
      ["UPDATE orders SET payment_status = 'pending', updated_at = ? WHERE id = ? AND payment_status != 'paid'", nowIso(), order.id],
      ["INSERT INTO order_events (order_id, kind, to_value, note) VALUES (?, 'payment', 'pending', ?)", order.id, `بدء الدفع الإلكتروني (${gw.label})`],
    ]);
    return { payment: await db.get('SELECT * FROM payments WHERE id = ?', payment.id), redirectUrl: res.redirectUrl };
  } catch (e) {
    await db.batch([
      ["UPDATE payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", String(e.message).slice(0, 300), nowIso(), payment.id],
      ["UPDATE orders SET payment_status = 'failed', updated_at = ? WHERE id = ? AND payment_status != 'paid'", nowIso(), order.id],
    ]);
    throw e;
  }
}

/**
 * Idempotently apply a gateway-reported result to a payment + its order.
 * The writes run as one atomic batch guarded by `status = <what we read>` and `changes()`, so two concurrent
 * deliveries of the same event cannot both apply (the loser changes 0 rows and records nothing).
 */
export async function applyResult(paymentId, { status, amount, raw }, by = 'gateway') {
  const { db } = rt;
  const pay = await db.get('SELECT * FROM payments WHERE id = ?', paymentId);
  if (!pay) return { changed: false, reason: 'unknown_payment' };
  const order = await db.get('SELECT * FROM orders WHERE id = ?', pay.order_id);
  if (pay.status === status) return { changed: false, reason: 'already_applied', payment: pay, order };
  if (pay.status === 'paid' && status !== 'refunded') return { changed: false, reason: 'already_paid', payment: pay, order };

  let finalStatus = status; let note = null;
  if (status === 'paid') {
    if (amount !== undefined && amount !== null && Number(amount) !== pay.amount) { finalStatus = 'failed'; note = 'مبلغ الدفع لا يطابق إجمالي الطلب — تحتاج مراجعة يدوية'; }
    else if (pay.amount !== order.total) { finalStatus = 'failed'; note = 'تغيّر إجمالي الطلب بعد بدء الدفع — تحتاج مراجعة يدوية'; }
  }
  const now = nowIso(); const prev = order.payment_status;
  const stmts = [['UPDATE payments SET status = ?, failure_reason = ?, raw = COALESCE(?, raw), updated_at = ? WHERE id = ? AND status = ?',
    finalStatus, note, raw ? JSON.stringify(raw).slice(0, 2000) : null, now, pay.id, pay.status]];
  if (finalStatus === 'paid') {
    stmts.push(["UPDATE orders SET payment_status = 'paid', updated_at = ? WHERE id = ? AND changes() > 0", now, order.id]);
    stmts.push(["INSERT INTO order_events (order_id, kind, from_value, to_value, note) SELECT ?, 'payment', ?, 'paid', ? WHERE changes() > 0", order.id, prev,
      prev === 'paid' ? 'دفعة مكررة وصلت لنفس الطلب — راجعها مع مزود الدفع' : `تأكيد الدفع من البوابة (${by})`]);
  } else if (prev !== 'paid') {
    stmts.push(["UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ? AND payment_status != 'paid' AND changes() > 0", finalStatus, now, order.id]);
    stmts.push(["INSERT INTO order_events (order_id, kind, from_value, to_value, note) SELECT ?, 'payment', ?, ?, ? WHERE changes() > 0", order.id, prev, finalStatus, note]);
  }
  const res = await db.batch(stmts);
  if (res[0].changes === 0) return { changed: false, reason: 'already_applied', payment: await db.get('SELECT * FROM payments WHERE id = ?', pay.id), order };
  return { changed: true, payment: await db.get('SELECT * FROM payments WHERE id = ?', pay.id), order: await db.get('SELECT * FROM orders WHERE id = ?', order.id) };
}

const findPayment = async (gwId, ev) =>
  (ev.providerRef && await rt.db.get('SELECT id FROM payments WHERE gateway_id = ? AND provider_ref = ?', gwId, String(ev.providerRef)))
  || (ev.paymentRef && await rt.db.get('SELECT id FROM payments WHERE gateway_id = ? AND idempotency_key = ?', gwId, String(ev.paymentRef)))
  || null;

/** Customer came back from the gateway. Only a signed return query or a server-side lookup can change anything. */
export async function handleReturn(order, query) {
  const pay = await rt.db.get('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1', order.id);
  if (!pay || pay.status === 'paid' || !pay.gateway_id) return pay;
  const gw = await getGateway(pay.gateway_id); if (!gw) return pay;
  try {
    if (gw.adapter.parseReturn && query && Object.keys(query).length) {
      const ev = gw.adapter.parseReturn({ query, gateway: gw });
      const target = await findPayment(gw.id, ev); if (target) await applyResult(target.id, ev, 'return');
    } else if (gw.adapter.fetchStatus) {
      const r = await gw.adapter.fetchStatus({ gateway: gw, payment: pay });
      if (r?.status && r.status !== 'pending') await applyResult(pay.id, r, 'verify');
    }
  } catch (e) { console.error('[payments] return handling failed:', e.message); }
  return rt.db.get('SELECT * FROM payments WHERE id = ?', pay.id);
}

/** Webhook entry point: verify signature → de-duplicate by event id → apply idempotently. `headers` is a Headers object. */
export async function handleWebhook(gatewayId, rawBody, headers) {
  const gw = await getGateway(gatewayId);
  if (!gw) return { status: 404, body: { error: 'unknown_gateway' } };
  let ev;
  try { ev = gw.adapter.parseWebhook({ rawBody, headers, gateway: gw }); }
  catch { return { status: 401, body: { error: 'invalid_signature' } }; }
  if (!ev?.eventId || (!ev.providerRef && !ev.paymentRef)) return { status: 400, body: { error: 'bad_event' } };
  const fresh = (await rt.db.run('INSERT OR IGNORE INTO webhook_events (provider, event_id) VALUES (?, ?)', `gw${gw.id}`, String(ev.eventId))).changes === 1;
  if (!fresh) return { status: 200, body: { ok: true, duplicate: true } };
  const pay = await findPayment(gw.id, ev);
  if (!pay) return { status: 202, body: { ok: true, ignored: 'unknown_reference' } };
  const r = await applyResult(pay.id, ev, 'webhook');
  return { status: 200, body: { ok: true, changed: r.changed } };
}

export const paymentsForOrder = (orderId) =>
  rt.db.all('SELECT id, provider, gateway_id, provider_ref, amount, currency, status, failure_reason, created_at, updated_at FROM payments WHERE order_id = ? ORDER BY id DESC', orderId);
export const gatewaySummary = async () => ({ enabled: (await rt.db.get('SELECT COUNT(*) AS n FROM payment_gateways WHERE enabled = 1')).n });
