// Plutu (plutu.ly) — Libyan payment gateways with a hosted payment page: local bank cards, MPGS, Tlync.
// Contract (from Plutu's public SDK): POST {base}/transaction/{gateway}/confirm with headers
//   X-API-KEY + Authorization: Bearer <access token>, JSON body {amount, invoice_no, return_url, lang, …}
//   → {result:{redirect_url, transaction_id}}. Plutu then sends the customer back to return_url (GET) and, for Tlync,
//   POSTs callback_url. Both carry `hashed` = UPPERCASE hex HMAC-SHA256(secret_key, "k=v&k=v…") over the allowed keys.
// Verify the base URL / fields against your Plutu dashboard documentation; both are editable from the admin panel.
import crypto from 'node:crypto';
import { gatewayFetch } from '../net.js';

const ALLOWED = {
  localbankcards: ['gateway', 'approved', 'canceled', 'invoice_no', 'amount', 'transaction_id'],
  tlync: ['gateway', 'approved', 'amount', 'invoice_no', 'canceled', 'payment_method', 'transaction_id'],
  mpgs: ['gateway', 'approved', 'invoice_no', 'amount', 'transaction_id'],
};
const truthy = (v) => ['1', 'true', 'yes', 'approved'].includes(String(v ?? '').toLowerCase());

export function plutuHash(params, secret, gw) {
  const allowed = ALLOWED[gw] || ALLOWED.localbankcards;
  const data = Object.keys(params).filter((k) => allowed.includes(k)).map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHmac('sha256', secret).update(data).digest('hex').toUpperCase();
}

function toEvent(params, gateway) {
  const gw = gateway.config.gateway || 'localbankcards';
  const given = String(params.hashed || '').toUpperCase(); const expected = plutuHash(params, gateway.secrets.secret_key || '', gw);
  if (!gateway.secrets.secret_key || given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) throw new Error('invalid hash');
  const status = truthy(params.approved) ? 'paid' : truthy(params.canceled) ? 'cancelled' : 'failed';
  const amount = params.amount !== undefined ? Math.round(Number(params.amount) * 1000) : undefined;
  return { eventId: `${params.invoice_no}:${params.transaction_id || ''}:${status}`, providerRef: params.transaction_id ? String(params.transaction_id) : null, paymentRef: params.invoice_no, status, amount: Number.isFinite(amount) ? amount : undefined, raw: { gateway: gw, transaction_id: params.transaction_id } };
}

export default {
  type: 'plutu',
  label: 'Plutu — بوابات ليبية (بطاقات / MPGS / Tlync)',
  description: 'تحويل العميل إلى صفحة دفع آمنة. تحتاج حساب تاجر لدى Plutu: API Key وAccess Token وSecret Key.',
  fields: [
    { key: 'gateway', label: 'نوع البوابة', kind: 'config', input: 'select', required: true, def: 'localbankcards',
      options: [['localbankcards', 'بطاقات مصرفية ليبية'], ['mpgs', 'بطاقات دولية (MPGS)'], ['tlync', 'Tlync (محافظ وتداول وسداد…)']] },
    { key: 'base_url', label: 'عنوان الـ API', kind: 'config', input: 'url', required: true, def: 'https://api.plutus.ly/api/v1', hint: 'اتركه كما هو إلا إذا أعطتك Plutu عنوانًا مختلفًا.' },
    { key: 'api_key', label: 'API Key', kind: 'secret', required: true },
    { key: 'access_token', label: 'Access Token', kind: 'secret', required: true },
    { key: 'secret_key', label: 'Secret Key (للتحقق من التوقيع)', kind: 'secret', required: true },
  ],

  async createPayment({ gateway, order, payment, returnUrl, webhookUrl }) {
    const gw = gateway.config.gateway || 'localbankcards';
    if (!ALLOWED[gw]) throw new Error('نوع بوابة Plutu غير معروف');
    const body = { amount: Number((order.total / 1000).toFixed(3)), invoice_no: payment.idempotency_key, return_url: returnUrl, lang: 'ar' };
    if (gw === 'tlync') {
      body.mobile_number = order.customer_phone.startsWith('218') ? '0' + order.customer_phone.slice(3) : order.customer_phone;
      body.callback_url = webhookUrl;
    }
    const res = await gatewayFetch(`${String(gateway.config.base_url).replace(/\/+$/, '')}/transaction/${gw}/confirm`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-API-KEY': gateway.secrets.api_key || '', Authorization: `Bearer ${gateway.secrets.access_token || ''}` },
    });
    const url = res.json?.result?.redirect_url;
    if (!res.ok || !url) throw new Error(res.json?.error?.message || `رفضت Plutu الطلب (${res.status})`);
    if (!/^https:\/\//i.test(url)) throw new Error('رابط الدفع من Plutu غير آمن');
    const tid = res.json.result.transaction_id;
    return { providerRef: tid ? String(tid) : null, redirectUrl: url, raw: { gateway: gw } };
  },

  /** Customer returns (GET) with a signed query string — the signature is the proof, not the browser. */
  parseReturn({ query, gateway }) { return toEvent(query, gateway); },

  /** Tlync callback (POST, JSON or form). */
  parseWebhook({ rawBody, gateway }) {
    const text = rawBody.toString('utf8'); let params;
    try { params = JSON.parse(text); } catch { params = Object.fromEntries(new URLSearchParams(text)); }
    if (!params || typeof params !== 'object') throw new Error('bad body');
    return toEvent(params, gateway);
  },
};
