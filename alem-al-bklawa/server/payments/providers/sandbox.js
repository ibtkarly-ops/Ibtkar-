// SANDBOX payment gateway — a TEST DOUBLE for development and automated tests only.
// It is impossible to enable in production (config.payment.sandbox is forced off when NODE_ENV=production).
// It behaves like a real hosted gateway: a hosted page, a signed webhook, and a server-side status lookup.
import crypto from 'node:crypto';
import { config } from '../../config.js';

const DEV_SECRET = 'sandbox-dev-secret';
const gateway = new Map(); // providerRef → { status, amount, currency }

const sign = (raw, secret) => crypto.createHmac('sha256', secret).update(raw).digest('hex');

export default {
  id: 'sandbox',
  label: 'دفع إلكتروني (بيئة اختبار)',
  devSecret: DEV_SECRET,

  async createPayment({ order, payment }) {
    const providerRef = 'sbx_' + crypto.randomBytes(9).toString('hex');
    gateway.set(providerRef, { status: 'pending', amount: payment.amount, currency: payment.currency, number: order.number });
    return { providerRef, redirectUrl: `/sandbox/pay/${providerRef}`, raw: { sandbox: true } };
  },

  async fetchStatus({ payment }) {
    const g = gateway.get(payment.provider_ref);
    if (!g) return { status: 'pending' };
    return { status: g.status, amount: g.amount, raw: { sandbox: true } };
  },

  parseWebhook({ rawBody, headers, secret }) {
    const given = String(headers['x-signature'] || '');
    const expected = sign(rawBody, secret || DEV_SECRET);
    if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) throw new Error('bad signature');
    const e = JSON.parse(rawBody.toString('utf8'));
    return { eventId: e.id, providerRef: e.ref, status: e.status, amount: e.amount, raw: { sandbox: true } };
  },

  // ── helpers used only by the sandbox hosted page ──
  _gateway: gateway,
  _signedEvent(ref, status) {
    const g = gateway.get(ref);
    const body = JSON.stringify({ id: 'evt_' + crypto.randomBytes(8).toString('hex'), ref, status, amount: g?.amount });
    return { body, signature: sign(body, config.payment.webhookSecret || DEV_SECRET) };
  },
};
