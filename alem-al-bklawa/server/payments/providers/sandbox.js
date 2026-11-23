// SANDBOX gateway — a TEST DOUBLE for development and automated tests only. It is registered only when
// NODE_ENV != production AND PAYMENT_SANDBOX=1, so it can never exist in a live store.
// It behaves like a real hosted gateway: hosted page, signed webhook, server-side status lookup.
// State lives in the kv table, so it works across Worker isolates too.
import crypto from 'node:crypto';
import { rt } from '../../runtime.js';

const SECRET = 'sandbox-dev-secret';
const sign = (raw) => crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
const keyOf = (ref) => `sbx:${ref}`;
const read = async (ref) => { const r = await rt.db.get('SELECT value FROM kv WHERE key = ?', keyOf(ref)); return r ? JSON.parse(r.value) : null; };

export default {
  type: 'sandbox',
  label: 'بيئة اختبار (لا تظهر في الإنتاج)',
  description: 'بوابة وهمية للتجربة المحلية فقط — لا يوجد خصم حقيقي.',
  fields: [],

  async createPayment({ order, payment }) {
    const providerRef = 'sbx_' + crypto.randomBytes(9).toString('hex');
    await rt.db.run('INSERT INTO kv (key, value) VALUES (?, ?)', keyOf(providerRef), JSON.stringify({ status: 'pending', amount: payment.amount, number: order.number }));
    return { providerRef, redirectUrl: `/sandbox/pay/${providerRef}`, raw: { sandbox: true } };
  },
  async fetchStatus({ payment }) {
    const g = await read(payment.provider_ref);
    return g ? { status: g.status, amount: g.amount } : { status: 'pending' };
  },
  parseWebhook({ rawBody, headers }) {
    const given = String(headers.get('x-signature') || ''); const expected = sign(rawBody);
    if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) throw new Error('bad signature');
    const e = JSON.parse(rawBody.toString('utf8'));
    return { eventId: e.id, providerRef: e.ref, status: e.status, amount: e.amount };
  },

  // helpers for the sandbox hosted page
  async _setStatus(ref, status) {
    const g = await read(ref);
    if (g && g.status === 'pending') await rt.db.run('UPDATE kv SET value = ? WHERE key = ?', JSON.stringify({ ...g, status }), keyOf(ref));
  },
  async _signedEvent(ref, status) {
    const g = await read(ref);
    const body = JSON.stringify({ id: 'evt_' + crypto.randomBytes(8).toString('hex'), ref, status, amount: g?.amount });
    return { body, signature: sign(body) };
  },
};
