// HTTP toolkit on the Web platform APIs (Request / Response / Headers), so the same code serves Node and Workers.
import crypto from 'node:crypto';
import { rt } from './runtime.js';
import { HttpError } from './lib.js';

// ── Router ─────────────────────────────────────────────────────────────────
export class Router {
  routes = [];
  add(method, pattern, ...fns) {
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, names, fns });
  }
  get(p, ...f) { this.add('GET', p, ...f); }
  post(p, ...f) { this.add('POST', p, ...f); }
  put(p, ...f) { this.add('PUT', p, ...f); }
  patch(p, ...f) { this.add('PATCH', p, ...f); }
  delete(p, ...f) { this.add('DELETE', p, ...f); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.names.forEach((n, i) => { try { params[n] = decodeURIComponent(m[i + 1]); } catch { params[n] = m[i + 1]; } });
      return { fns: r.fns, params };
    }
    return null;
  }
}

// ── Client IP / origin / scheme ────────────────────────────────────────────
export function clientIp(request, info = {}) {
  const h = request.headers;
  if (rt.platform.name === 'workers') return h.get('cf-connecting-ip') || 'unknown';
  if (rt.config.trustProxy) {
    const xf = h.get('x-forwarded-for'); if (xf) return xf.split(',')[0].trim();
    const cf = h.get('cf-connecting-ip'); if (cf) return cf;
  }
  return info.remoteAddress || 'unknown';
}
/** Public origin: SITE_URL when configured, otherwise the origin the visitor actually used. */
export const originOf = (request) => (rt.config.siteUrlConfigured ? rt.config.siteUrl : new URL(request.url).origin);
export function isSecure(request) {
  if (new URL(request.url).protocol === 'https:') return true;
  return rt.config.isProd && (rt.config.siteUrl.startsWith('https://') || (rt.config.trustProxy && request.headers.get('x-forwarded-proto') === 'https'));
}

// ── Cookies ────────────────────────────────────────────────────────────────
export function parseCookies(headers) {
  const out = {};
  for (const part of String(headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip malformed */ }
  }
  return out;
}
export function cookieHeader(name, value, { maxAge, secure } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// ── Body ───────────────────────────────────────────────────────────────────
export async function readBody(request, limit = 64 * 1024) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > limit) throw new HttpError(413, 'too_large', 'الحجم كبير جدًا');
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > limit) { try { await reader.cancel(); } catch { /* */ } throw new HttpError(413, 'too_large', 'الحجم كبير جدًا'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
export async function readJson(request, limit = 64 * 1024) {
  const ct = String(request.headers.get('content-type') || '');
  if (!ct.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type', 'نوع المحتوى غير مدعوم');
  const buf = await readBody(request, limit);
  if (!buf.length) return {};
  try { const v = JSON.parse(buf.toString('utf8')); return v && typeof v === 'object' ? v : {}; }
  catch { throw new HttpError(400, 'bad_json', 'بيانات غير صالحة'); }
}

// ── Rate limiting (platform-provided: memory on Node, D1 on Workers) ───────
/** Resolves true when the request is allowed. */
export const rateLimit = (key, max, windowMs, opts) => rt.platform.rateLimit(key, max, windowMs, opts);
export const rateLimitReset = (key) => rt.platform.rateLimitReset?.(key);

// ── Security headers ───────────────────────────────────────────────────────
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'",
  "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

export function applySecurityHeaders(headers, request) {
  headers.set('Content-Security-Policy', CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (isSecure(request)) headers.set('Strict-Transport-Security', 'max-age=15552000');
}

/** CSRF defence for cookie-authenticated mutations: same-origin only. */
export function sameOriginOk(request) {
  const origin = request.headers.get('origin');
  if (origin) { try { return new URL(origin).host === new URL(request.url).host; } catch { return false; } }
  const site = request.headers.get('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
}

// ── Responses ──────────────────────────────────────────────────────────────
export const jsonResponse = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
export const textResponse = (status, body, type = 'text/plain; charset=utf-8', extra = {}) =>
  new Response(body, { status, headers: { 'content-type': type, ...extra } });
export const redirectResponse = (location, status = 302) => new Response(null, { status, headers: { location, 'cache-control': 'no-store' } });

export const randomHex = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
