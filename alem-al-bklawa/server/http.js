// Tiny HTTP toolkit: router, body parsing, cookies, rate limiting, security headers, static files.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { config } from './config.js';
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

// ── Client IP ──────────────────────────────────────────────────────────────
export function clientIp(req) {
  if (config.trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf);
  }
  return req.socket.remoteAddress || 'unknown';
}

// ── Cookies ────────────────────────────────────────────────────────────────
export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function cookieHeader(name, value, { maxAge, secure } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
export function isSecure(req) {
  return config.isProd && (req.socket.encrypted || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https') || config.siteUrl.startsWith('https://'));
}

// ── Body ───────────────────────────────────────────────────────────────────
export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > limit) { req.resume(); return reject(new HttpError(413, 'too_large', 'الحجم كبير جدًا')); }
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); return reject(new HttpError(413, 'too_large', 'الحجم كبير جدًا')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
export async function readJson(req, limit = 64 * 1024) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type', 'نوع المحتوى غير مدعوم');
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { const v = JSON.parse(buf.toString('utf8')); return v && typeof v === 'object' ? v : {}; }
  catch { throw new HttpError(400, 'bad_json', 'بيانات غير صالحة'); }
}

// ── Rate limiting (in-memory, per process) ─────────────────────────────────
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count += 1;
  return b.count <= max;
}
export function rateLimitReset(key) { buckets.delete(key); }
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k); }, 60_000).unref();

// ── Security headers ───────────────────────────────────────────────────────
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
}

/** CSRF defence for cookie-authenticated mutations: same-origin only. */
export function sameOriginOk(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin) {
    try { return new URL(origin).host === host; } catch { return false; }
  }
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

// ── Responses ──────────────────────────────────────────────────────────────
export function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Length': buf.length, ...headers });
  res.end(buf);
}
export function sendJson(req, res, status, obj) {
  let buf = Buffer.from(JSON.stringify(obj));
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (buf.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    buf = zlib.gzipSync(buf, { level: 5 });
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  res.writeHead(status, { ...headers, 'Content-Length': buf.length });
  res.end(buf);
}
export function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

// ── Static files ───────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.webmanifest']);
const zcache = new Map(); // `${file}:${mtime}:${enc}` → Buffer

export function serveStatic(req, res, baseDir, rel, { immutable = false } = {}) {
  let p;
  try { p = decodeURIComponent(rel); } catch { return false; }
  if (p.includes('\0')) return false;
  const file = path.resolve(baseDir, '.' + path.posix.normalize('/' + p));
  if (file !== baseDir && !file.startsWith(baseDir + path.sep)) return false;
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext];
  if (!type) return false;
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const cc = immutable || ext === '.woff2' ? 'public, max-age=31536000, immutable'
    : ext === '.html' ? 'no-cache'
      : ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico'].includes(ext) ? 'public, max-age=86400'
        : 'public, max-age=300';
  const headers = { 'Content-Type': type, 'Cache-Control': cc, ETag: etag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
  let body = null; let enc = '';
  if (COMPRESSIBLE.has(ext)) {
    const ae = String(req.headers['accept-encoding'] || '');
    enc = /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : '';
    if (enc) {
      const k = `${file}:${st.mtimeMs}:${enc}`;
      body = zcache.get(k);
      if (!body) {
        const raw = fs.readFileSync(file);
        body = enc === 'br' ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) : zlib.gzipSync(raw, { level: 6 });
        zcache.set(k, body);
      }
      headers['Content-Encoding'] = enc;
    }
  }
  if (req.method === 'HEAD') { res.writeHead(200, { ...headers, 'Content-Length': body ? body.length : st.size }); res.end(); return true; }
  if (!body) {
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': body.length });
  res.end(body);
  return true;
}

export const randomHex = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
