// Node.js platform: node:sqlite + files on disk. Used by the server (index.js) and by the CLI scripts.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { setRuntime } from './runtime.js';
import { makeConfig } from './config.js';
import { openNodeDb } from './db.js';
import { randomHex } from './http.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.webmanifest']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico']);

/** Static files from a directory as Web Responses (etag, gzip/brotli, cache headers). Returns null when not found. */
function staticFiles(baseDir) {
  const zcache = new Map(); // `${file}:${mtime}:${enc}` → Buffer
  const resolve = (rel) => {
    let p; try { p = decodeURIComponent(rel); } catch { return null; }
    if (p.includes('\0')) return null;
    const file = path.resolve(baseDir, '.' + path.posix.normalize('/' + p));
    if (file !== baseDir && !file.startsWith(baseDir + path.sep)) return null;
    const base = path.basename(file);
    if (base.startsWith('_') || base.startsWith('.')) return null; // _headers (Cloudflare) and dotfiles are never served
    let st; try { st = fs.statSync(file); } catch { return null; }
    return st.isFile() ? { file, st } : null;
  };
  return {
    fetch(request) {
      const hit = resolve(new URL(request.url).pathname); if (!hit) return null;
      const { file, st } = hit; const ext = path.extname(file).toLowerCase(); const type = MIME[ext]; if (!type) return null;
      const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      const cc = ext === '.woff2' ? 'public, max-age=31536000, immutable' : ext === '.html' ? 'no-cache' : IMAGE_EXT.has(ext) ? 'public, max-age=86400' : 'public, max-age=300';
      const headers = { 'content-type': type, 'cache-control': cc, etag, vary: 'Accept-Encoding' };
      if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
      let body = fs.readFileSync(file);
      if (COMPRESSIBLE.has(ext)) {
        const ae = request.headers.get('accept-encoding') || '';
        const enc = /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : '';
        if (enc) {
          const k = `${file}:${st.mtimeMs}:${enc}`; let z = zcache.get(k);
          if (!z) { z = enc === 'br' ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) : zlib.gzipSync(body, { level: 6 }); zcache.set(k, z); }
          body = z; headers['content-encoding'] = enc;
        }
      }
      return new Response(body, { status: 200, headers });
    },
    text(rel) { const h = resolve(rel); if (!h) throw new Error(`asset not found: ${rel}`); return fs.readFileSync(h.file, 'utf8'); },
  };
}

function loadSecretKey(env, dataDir) {
  if (env.APP_SECRET && env.APP_SECRET.length >= 32) return new Uint8Array(crypto.createHash('sha256').update(env.APP_SECRET).digest());
  const file = path.join(dataDir, '.secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return new Uint8Array(Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'));
}

const FORWARD_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'x-forwarded-host'];
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/** Builds config + SQLite database + platform from environment variables and registers them as the active runtime. */
export function createNodeRuntime(env = process.env) {
  const dataDir = path.resolve(ROOT, env.DATA_DIR || './data');
  const uploadsDir = path.join(dataDir, 'uploads');
  const codeFile = path.join(dataDir, 'setup-code.txt');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const config = makeConfig(env, { root: ROOT, dataDir, publicDir: path.join(ROOT, 'public') });
  const db = openNodeDb(env.DB_PATH || path.join(dataDir, 'store.db'));
  const secretKey = loadSecretKey(env, dataDir);
  const assets = staticFiles(config.publicDir);

  const buckets = new Map();
  const timer = setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k); }, 60_000); timer.unref();

  const migDir = path.join(ROOT, 'server', 'migrations');
  const migrations = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: fs.readFileSync(path.join(migDir, name), 'utf8') }));

  const adminExists = () => !!db.raw.prepare("SELECT 1 FROM profiles WHERE role = 'admin' AND deleted_at IS NULL LIMIT 1").get();
  /** Returns the pending setup code (creating it) or null once an admin exists. SETUP_CODE overrides the generated one. */
  const expectedCode = () => {
    if (config.setupCode) return config.setupCode.toUpperCase().replace(/[\s-]/g, '');
    try { const c = fs.readFileSync(codeFile, 'utf8').trim(); if (c) return c; } catch { /* create below */ }
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
    fs.writeFileSync(codeFile, code + '\n', { mode: 0o600 });
    return code;
  };

  const platform = {
    name: 'node',
    assets,
    defaultLogo: fs.existsSync(path.join(config.publicDir, 'assets', 'logo.webp')) ? '/assets/logo.webp' : '',
    maxUploadBytes: 1024 * 1024,
    uploads: {
      async put(bytes, ext) { const name = `${randomHex(12)}.${ext}`; fs.writeFileSync(path.join(uploadsDir, name), bytes); return name; },
      async get(name) {
        const file = path.join(uploadsDir, path.basename(name));
        try { return { bytes: fs.readFileSync(file), mime: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }; } catch { return null; }
      },
    },
    async rateLimit(key, max, windowMs) {
      const now = Date.now(); let b = buckets.get(key);
      if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
      b.count += 1; return b.count <= max;
    },
    rateLimitReset(key) { buckets.delete(key); },
    async getSecretKey() { return secretKey; },
    setup: {
      // From the same computer (loopback, no proxy headers) no code is needed; from anywhere else the code is required.
      needsCode: (request, info = {}) => !(LOOPBACK.includes(info.remoteAddress) && !FORWARD_HEADERS.some((h) => request.headers.get(h))),
      async expectedCode() { return adminExists() ? null : expectedCode(); },
      async done() { try { fs.rmSync(codeFile, { force: true }); } catch { /* */ } },
      codeHint: 'رمز الإعداد غير صحيح. تجده في سجل تشغيل الخادم أو في الملف data/setup-code.txt.',
      codeWhere: 'تجده في سجل تشغيل الخادم (سطر «إعداد أولي») أو في الملف data/setup-code.txt. من نفس جهاز الخادم لا تحتاجه.',
      pending: () => (adminExists() ? null : expectedCode()),
      codePath: codeFile,
    },
    async dnsLookup(host) { return (await dns.lookup(host, { all: true })).map((a) => a.address); },
    migrations,
  };
  setRuntime({ db, platform, config });
  return { config, db, platform };
}
