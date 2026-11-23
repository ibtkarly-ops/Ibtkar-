// Small helpers: safe HTML templating (auto-escaping), formatting, WhatsApp links, storage.
const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENT[c]);

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s ?? ''));
const toStr = (v) => (v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(toStr).join('') : esc(v));
/** Tagged template: every ${value} is HTML-escaped unless it is itself an html`` result or raw(). */
export const html = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? toStr(vals[i]) : ''), ''));
export const setHtml = (el, tpl) => { el.innerHTML = tpl instanceof Raw ? tpl.s : esc(tpl); return el; };

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ── Money (server sends integer dirhams; 1 LYD = 1000) ──
let currencyLabel = 'د.ل';
export const setCurrency = (l) => { currencyLabel = l || 'د.ل'; };
export function money(d) {
  const v = (Number(d) || 0) / 1000;
  return `${v.toLocaleString('en-US', { maximumFractionDigits: 3 })} ${currencyLabel}`;
}

// ── Dates ──
let dtf; try { dtf = new Intl.DateTimeFormat('ar-LY-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' }); } catch { dtf = new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }); }
export const fmtDate = (iso) => { try { return dtf.format(new Date(iso)); } catch { return iso || ''; } };

// ── Phones & WhatsApp ──
export const displayPhone = (p) => { const s = String(p || ''); return s.startsWith('218') ? '0' + s.slice(3) : s; };
export const waLink = (number, text) => `https://wa.me/${String(number).replace(/\D/g, '')}${text ? '?text=' + encodeURIComponent(text) : ''}`;
export const telLink = (p) => 'tel:+' + String(p || '').replace(/\D/g, '').replace(/^0/, '218');

// ── Safe storage ──
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
};

export const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36));
export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── Icons (inline, accessible labels live on the buttons) ──
const P = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  bag: '<path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  pin: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v8h14v-8M8 8a2.5 2.5 0 1 1 4-2c0 .8-.3 1.5-.6 2M16 8a2.5 2.5 0 1 0-4-2"/>',
};
export const icon = (name, cls = '') => raw(`<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`);
export const tiktokIcon = () => raw('<svg class="icon icon-fill" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M16.6 3a5.5 5.5 0 0 0 4.4 4.9v3.4a8.9 8.9 0 0 1-4.3-1.3v6.2a6.3 6.3 0 1 1-6.3-6.3c.4 0 .8 0 1.2.1v3.5a2.9 2.9 0 1 0 1.9 2.7V3h3.1Z"/></svg>');

// Real logo (uploaded) or the temporary typographic placeholder until the owner uploads it.
export function logoDisc(settings, size = 44) {
  const url = settings.logo_url;
  const inner = url
    ? `<img src="${esc(url)}" alt="" width="${size}" height="${size}" decoding="async">`
    : '<svg viewBox="0 0 200 200" aria-hidden="true"><rect width="200" height="200" fill="#800020"/><circle cx="100" cy="100" r="88" fill="none" stroke="#C6A15B" stroke-width="2"/><text x="100" y="94" text-anchor="middle" font-family="Cairo,sans-serif" font-weight="800" font-size="34" fill="#fff">عالم</text><text x="100" y="134" text-anchor="middle" font-family="Cairo,sans-serif" font-weight="800" font-size="34" fill="#C6A15B">البكلاوه</text></svg>';
  return raw(`<span class="logo-disc" style="width:${size}px;height:${size}px">${inner}</span>`);
}
