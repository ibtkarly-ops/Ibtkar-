// Generic REST gateway — connects ANY provider that offers a "create payment → redirect URL" API, configured entirely
// from the admin panel: endpoint, headers, JSON/form body template with placeholders, where to read the payment link and
// reference in the reply, optional status-lookup endpoint, and an HMAC-signed webhook. No code changes needed.
import crypto from 'node:crypto';
import { gatewayFetch } from '../net.js';

const PH = /\{\{\s*([a-z_]+)(?::(number))?\s*\}\}/gi;
const WHOLE = /^\{\{\s*([a-z_]+)(?::(number))?\s*\}\}$/i;

export function getPath(obj, p) {
  if (!p) return undefined;
  return String(p).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export function fill(v, vars) {
  if (typeof v === 'string') {
    const w = WHOLE.exec(v);
    if (w && vars[w[1]] !== undefined) return w[2] ? Number(vars[w[1]]) : String(vars[w[1]]);
    return v.replace(PH, (_, k) => (vars[k] === undefined ? '' : String(vars[k])));
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]));
  return v;
}
const list = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
export function mapStatus(value, cfg) {
  const v = String(value ?? '').toLowerCase();
  if (list(cfg.paid_values).includes(v)) return 'paid';
  if (list(cfg.failed_values).includes(v)) return 'failed';
  if (list(cfg.cancelled_values).includes(v)) return 'cancelled';
  return 'pending';
}
const parseJson = (s, what) => { try { const o = JSON.parse(s || '{}'); if (!o || typeof o !== 'object') throw 0; return o; } catch { throw new Error(`${what}: JSON غير صالح`); } };

function vars({ gateway, order, payment, returnUrl, cancelUrl, webhookUrl }) {
  return {
    amount: (order.total / 1000).toFixed(3), amount_minor: String(order.total), currency: order.currency, order_number: order.number,
    payment_ref: payment.idempotency_key, provider_ref: payment.provider_ref || '', return_url: returnUrl, cancel_url: cancelUrl || returnUrl, webhook_url: webhookUrl,
    customer_name: order.customer_name, customer_phone: order.customer_phone, customer_phone_local: order.customer_phone.startsWith('218') ? '0' + order.customer_phone.slice(3) : order.customer_phone,
    description: `طلب ${order.number}`, api_key: gateway.secrets.api_key || '', api_secret: gateway.secrets.api_secret || '',
  };
}
const headersFor = (cfg, v) => Object.fromEntries(Object.entries(fill(parseJson(cfg.create_headers, 'الترويسات'), v)).map(([k, x]) => [k, String(x)]));

export default {
  type: 'generic',
  label: 'بوابة عامة عبر API (أي مزوّد)',
  description: 'اربط أي بوابة تدعم إنشاء دفعة وإرجاع رابط دفع: تحدّد العنوان والترويسات وقالب الطلب وأماكن القراءة من الرد.',
  fields: [
    { key: 'create_url', label: 'عنوان إنشاء الدفعة (https)', kind: 'config', input: 'url', required: true },
    { key: 'body_format', label: 'صيغة الطلب', kind: 'config', input: 'select', def: 'json', options: [['json', 'JSON'], ['form', 'Form (x-www-form-urlencoded)']] },
    { key: 'create_headers', label: 'الترويسات (JSON)', kind: 'config', input: 'textarea', def: '{"Authorization": "Bearer {{api_key}}", "Content-Type": "application/json"}', hint: 'المتغيرات: {{api_key}} {{api_secret}}' },
    { key: 'create_body', label: 'قالب الطلب (JSON)', kind: 'config', input: 'textarea', required: true, def: '{\n  "amount": "{{amount:number}}",\n  "currency": "{{currency}}",\n  "reference": "{{payment_ref}}",\n  "return_url": "{{return_url}}",\n  "callback_url": "{{webhook_url}}"\n}',
      hint: 'المتغيرات: {{amount}} (د.ل بثلاث خانات) {{amount_minor}} (بالدرهم) {{currency}} {{order_number}} {{payment_ref}} {{return_url}} {{cancel_url}} {{webhook_url}} {{customer_name}} {{customer_phone}} {{customer_phone_local}} {{description}}. أضف :number لإرسال رقم بدل نص.' },
    { key: 'redirect_path', label: 'مسار رابط الدفع في الرد', kind: 'config', input: 'text', required: true, def: 'data.checkout_url', hint: 'مثال: data.checkout_url أو result.redirect_url' },
    { key: 'ref_path', label: 'مسار مرجع العملية في الرد', kind: 'config', input: 'text', def: 'data.id' },
    { key: 'status_url', label: 'عنوان الاستعلام عن الحالة (اختياري)', kind: 'config', input: 'url', hint: 'يدعم {{provider_ref}} و{{payment_ref}}. يُستخدم للتحقق من الخادم عند عودة العميل.' },
    { key: 'status_path', label: 'مسار الحالة في رد الاستعلام', kind: 'config', input: 'text', def: 'data.status' },
    { key: 'paid_values', label: 'قيم «مدفوع»', kind: 'config', input: 'text', def: 'paid,succeeded,success,completed,approved' },
    { key: 'failed_values', label: 'قيم «فشل»', kind: 'config', input: 'text', def: 'failed,declined,error,expired' },
    { key: 'cancelled_values', label: 'قيم «ملغي»', kind: 'config', input: 'text', def: 'cancelled,canceled,voided' },
    { key: 'webhook_sig_header', label: 'ترويسة توقيع الـ Webhook', kind: 'config', input: 'text', def: 'x-signature' },
    { key: 'webhook_algo', label: 'خوارزمية التوقيع', kind: 'config', input: 'select', def: 'sha256', options: [['sha256', 'HMAC-SHA256'], ['sha512', 'HMAC-SHA512']] },
    { key: 'webhook_encoding', label: 'ترميز التوقيع', kind: 'config', input: 'select', def: 'hex', options: [['hex', 'hex'], ['base64', 'base64']] },
    { key: 'webhook_ref_path', label: 'مسار المرجع في الـ Webhook', kind: 'config', input: 'text', def: 'data.id' },
    { key: 'webhook_ref_kind', label: 'المرجع في الـ Webhook هو', kind: 'config', input: 'select', def: 'provider_ref', options: [['provider_ref', 'مرجع المزوّد (من رد الإنشاء)'], ['payment_ref', 'مرجعنا ({{payment_ref}})']] },
    { key: 'webhook_status_path', label: 'مسار الحالة في الـ Webhook', kind: 'config', input: 'text', def: 'data.status' },
    { key: 'webhook_event_path', label: 'مسار معرّف الحدث (لمنع التكرار)', kind: 'config', input: 'text', def: 'id' },
    { key: 'webhook_amount_path', label: 'مسار المبلغ في الـ Webhook (اختياري)', kind: 'config', input: 'text' },
    { key: 'webhook_amount_unit', label: 'وحدة المبلغ في الـ Webhook', kind: 'config', input: 'select', def: 'lyd', options: [['lyd', 'دينار'], ['dirham', 'درهم (1/1000 دينار)']] },
    { key: 'api_key', label: 'API Key / Token', kind: 'secret' },
    { key: 'api_secret', label: 'API Secret (اختياري)', kind: 'secret' },
    { key: 'webhook_secret', label: 'Webhook Secret (مطلوب لقبول الإشعارات)', kind: 'secret' },
  ],

  async createPayment(ctx) {
    const cfg = ctx.gateway.config; const v = vars(ctx);
    const tpl = fill(parseJson(cfg.create_body, 'قالب الطلب'), v);
    const headers = headersFor(cfg, v);
    let body;
    if (cfg.body_format === 'form') { body = new URLSearchParams(Object.entries(tpl).map(([k, x]) => [k, String(x)])).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    else { body = JSON.stringify(tpl); if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'; }
    const res = await gatewayFetch(cfg.create_url, { method: 'POST', headers, body });
    if (!res.ok) throw new Error(`رفضت البوابة الطلب (${res.status})`);
    const url = getPath(res.json, cfg.redirect_path);
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) throw new Error('رد البوابة لا يحوي رابط دفع https صالحًا — راجع «مسار رابط الدفع»');
    const ref = getPath(res.json, cfg.ref_path);
    return { providerRef: ref !== undefined && ref !== null ? String(ref) : null, redirectUrl: url, raw: { status: res.status } };
  },

  async fetchStatus({ gateway, payment }) {
    const cfg = gateway.config;
    if (!cfg.status_url) return { status: 'pending' };
    const v = { provider_ref: payment.provider_ref || '', payment_ref: payment.idempotency_key, api_key: gateway.secrets.api_key || '', api_secret: gateway.secrets.api_secret || '' };
    const url = String(cfg.status_url).replace(PH, (_, k) => encodeURIComponent(v[k] ?? ''));
    const headers = headersFor(cfg, v); delete headers['Content-Type'];
    const res = await gatewayFetch(url, { headers });
    if (!res.ok) return { status: 'pending' };
    return { status: mapStatus(getPath(res.json, cfg.status_path), cfg) };
  },

  parseWebhook({ rawBody, headers, gateway }) {
    const cfg = gateway.config; const secret = gateway.secrets.webhook_secret;
    if (!secret) throw new Error('webhook secret not configured');
    const algo = cfg.webhook_algo === 'sha512' ? 'sha512' : 'sha256';
    const expected = crypto.createHmac(algo, secret).update(rawBody).digest(cfg.webhook_encoding === 'base64' ? 'base64' : 'hex');
    const given = String(headers.get(String(cfg.webhook_sig_header || 'x-signature').toLowerCase()) || '').replace(/^(sha256|sha512)=/i, '');
    const a = Buffer.from(given); const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('bad signature');
    const json = JSON.parse(rawBody.toString('utf8'));
    const ref = getPath(json, cfg.webhook_ref_path);
    const status = mapStatus(getPath(json, cfg.webhook_status_path), cfg);
    const eid = getPath(json, cfg.webhook_event_path);
    const amt = cfg.webhook_amount_path ? Number(getPath(json, cfg.webhook_amount_path)) : undefined;
    return {
      eventId: eid !== undefined && eid !== null ? `${eid}:${status}` : crypto.createHash('sha256').update(rawBody).digest('hex'),
      providerRef: cfg.webhook_ref_kind === 'payment_ref' ? null : ref !== undefined ? String(ref) : null,
      paymentRef: cfg.webhook_ref_kind === 'payment_ref' && ref !== undefined ? String(ref) : null,
      status, amount: Number.isFinite(amt) ? Math.round(cfg.webhook_amount_unit === 'dirham' ? amt : amt * 1000) : undefined,
    };
  },
};
