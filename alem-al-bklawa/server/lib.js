// Shared helpers: Arabic normalisation, money, phone, slugs, validation.

// ── Arabic text normalisation (search) ─────────────────────────────────────
const DIAC = /[ً-ٰٟۖ-ۭـ]/g; // tashkeel + tatweel
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function normalizeAr(input) {
  let s = String(input ?? '').toLowerCase().replace(DIAC, '');
  s = s
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي').replace(/ی/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/ک/g, 'ك')
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)));
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.split(' ').map((t) => {
    // Common spelling variants of the shop's core product (بقلاوة / بكلاوة / baklava …)
    if (/^(?:ب|با)[قك]لاو[هاي]?$/.test(t) || /^(?:baklaw[ae]?|baklava|baqlawa|baklawa)$/.test(t)) return 'بكلاوه';
    // Drop the definite article so "البكلاوه" matches "بكلاوه"
    if (t.length > 3 && t.startsWith('ال')) return t.slice(2);
    return t;
  }).join(' ');
}

// Tokens are capped at 20 characters: D1 rejects LIKE patterns longer than 50 bytes.
export const tokens = (q) => normalizeAr(q).split(' ').filter(Boolean).slice(0, 8).map((t) => t.slice(0, 20));

// ── Money: integer dirhams (1 LYD = 1000) ──────────────────────────────────
export function lydToDirham(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return NaN;
  return Math.round(n * 1000);
}
export const dirhamToLyd = (d) => (d === null || d === undefined ? null : d / 1000);

// ── Phone numbers (Libya-first) ────────────────────────────────────────────
/** Normalise to international digits without '+', e.g. 0925006674 → 218925006674. Returns '' if invalid. */
export function normalizePhone(input) {
  let d = String(input ?? '').replace(/[٠-٩]/g, (c) => String(AR_DIGITS.indexOf(c))).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '218' + d.slice(1);
  else if (/^9\d{8}$/.test(d)) d = '218' + d;
  if (!/^\d{9,15}$/.test(d)) return '';
  // Libya: the owner's own support line has 8 digits after the country code, mobiles have 9.
  if (d.startsWith('218') && !/^218\d{8,10}$/.test(d)) return '';
  return d;
}
/** 218925006674 → 0925006674 (local display) */
export function displayPhone(p) {
  const s = String(p ?? '');
  return s.startsWith('218') ? '0' + s.slice(3) : s;
}

// ── Slugs (Arabic-aware) ───────────────────────────────────────────────────
export function slugify(s) {
  return String(s ?? '').trim().toLowerCase().replace(DIAC, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
}

// ── Validation ─────────────────────────────────────────────────────────────
export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status; this.code = code; this.extra = extra;
  }
}
export const bad = (code, message, extra) => new HttpError(400, code, message, extra);

export function str(v, { min = 0, max = 500, field = 'field', required = false, trim = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad('invalid_' + field, 'هذا الحقل مطلوب', { field });
    return '';
  }
  if (typeof v !== 'string') throw bad('invalid_' + field, 'قيمة غير صالحة', { field });
  const s = (trim ? v.trim() : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  if (required && !s) throw bad('invalid_' + field, 'هذا الحقل مطلوب', { field });
  if (s.length < min) throw bad('invalid_' + field, `الحد الأدنى ${min} أحرف`, { field });
  if (s.length > max) throw bad('invalid_' + field, `الحد الأقصى ${max} حرفًا`, { field });
  return s;
}
export function int(v, { min = 0, max = 1e9, field = 'field', required = true, def = 0 } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad('invalid_' + field, 'قيمة مطلوبة', { field });
    return def;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad('invalid_' + field, 'قيمة غير صالحة', { field });
  return n;
}
export const flag = (v, def = 0) => (v === undefined || v === null ? def : v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

export function emailOrEmpty(v, field = 'email') {
  const s = str(v, { max: 120, field }).toLowerCase();
  if (!s) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw bad('invalid_' + field, 'البريد الإلكتروني غير صالح', { field });
  return s;
}

/** Only allow relative links or http(s) URLs. */
export function safeUrl(v, field = 'url') {
  const s = str(v, { max: 500, field });
  if (!s) return '';
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  try {
    const u = new URL(s);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.toString();
  } catch { /* fallthrough */ }
  throw bad('invalid_' + field, 'الرابط غير صالح', { field });
}
export function safeImage(v, field = 'image') {
  const s = str(v, { max: 300, field });
  if (!s) return null;
  if (/^\/uploads\/[a-f0-9]{24}\.(webp|jpg|png)$/.test(s) || /^\/assets\/[\w.\-/]+$/.test(s)) return s;
  throw bad('invalid_' + field, 'مسار الصورة غير صالح', { field });
}
export function isoOrNull(v, field = 'date') {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw bad('invalid_' + field, 'تاريخ غير صالح', { field });
  return d.toISOString();
}

export const ORDER_STATUSES = ['new', 'confirming', 'preparing', 'ready', 'delivered', 'cancelled'];
export const ORDER_STATUS_LABELS = {
  new: 'جديد', confirming: 'قيد التأكيد', preparing: 'قيد التحضير',
  ready: 'جاهز للاستلام', delivered: 'تم التسليم', cancelled: 'ملغي',
};
export const PAYMENT_STATUS_LABELS = {
  unpaid: 'غير مدفوع', pending: 'بانتظار الدفع', paid: 'مدفوع',
  failed: 'فشل الدفع', cancelled: 'أُلغي الدفع', refunded: 'مسترد',
};
