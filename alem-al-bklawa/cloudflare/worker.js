// Cloudflare Workers entry: the whole store (same code as the Node server) on Workers + D1 + static assets.
//
//   env.DB       – D1 database (created automatically by `wrangler deploy` / the Cloudflare dashboard)
//   env.ASSETS   – the storefront/admin static files (public/)
//   env.*        – optional variables: SITE_URL, APP_SECRET, SETUP_CODE, PASSWORD_ITERATIONS, TRUST_PROXY…
import { setRuntime } from '../server/runtime.js';
import { makeConfig } from '../server/config.js';
import { norm } from '../server/dbutil.js';
import { handle } from '../server/app.js';
import { randomHex } from '../server/http.js';
import m001 from '../server/migrations/001_init.sql';
import m002 from '../server/migrations/002_payment_gateways.sql';
import m003 from '../server/migrations/003_runtime_tables.sql';

const MIGRATIONS = [
  { name: '001_init.sql', sql: m001 },
  { name: '002_payment_gateways.sql', sql: m002 },
  { name: '003_runtime_tables.sql', sql: m003 },
];

const MIME = { webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png' };
const b64encode = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const b64decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** D1 behind the shared async database interface (see server/dbutil.js). */
function d1(binding) {
  const prep = (sql, p) => binding.prepare(sql).bind(...p.map(norm));
  const meta = (r) => ({ rows: r.results || [], changes: r.meta?.changes ?? 0, lastInsertRowid: r.meta?.last_row_id ?? 0 });
  return {
    async all(sql, ...p) { return (await prep(sql, p).all()).results || []; },
    async get(sql, ...p) { return (await prep(sql, p).first()) ?? undefined; },
    async run(sql, ...p) { const r = meta(await prep(sql, p).run()); return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }; },
    // D1 runs a batch in one implicit transaction, statements in order, all-or-nothing.
    async batch(list) { return (await binding.batch(list.map(([sql, ...p]) => prep(sql, p)))).map(meta); },
  };
}

function buildPlatform(env, config, db) {
  const soft = new Map(); // per-isolate counters for non-critical limits (saves D1 writes)
  let secretKey = null;
  const assetText = new Map();
  const fetchAsset = (path) => env.ASSETS.fetch(new Request(`https://assets.local${path}`));

  return {
    name: 'workers',
    defaultLogo: '/assets/logo.webp',
    maxUploadBytes: 1024 * 1024, // stored as base64 in a D1 row (limit 2 MB)
    migrations: MIGRATIONS,
    assets: {
      async fetch(request) { const res = await env.ASSETS.fetch(request); return res.status === 404 ? null : res; },
      async text(path) {
        if (assetText.has(path)) return assetText.get(path);
        const res = await fetchAsset(path);
        if (!res.ok) throw new Error(`asset not found: ${path}`);
        const t = await res.text(); assetText.set(path, t); return t; // assets are immutable per deployed version
      },
    },
    uploads: {
      async put(bytes, ext) {
        const name = `${randomHex(12)}.${ext}`;
        await db.run('INSERT INTO uploads (name, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?)', name, MIME[ext], bytes.length, b64encode(bytes), new Date().toISOString());
        return name;
      },
      async get(name) {
        const row = await db.get('SELECT mime, data FROM uploads WHERE name = ?', name);
        return row ? { bytes: b64decode(row.data), mime: row.mime } : null;
      },
    },
    async rateLimit(key, max, windowMs, { soft: isSoft } = {}) {
      const now = Date.now();
      if (isSoft) {
        let b = soft.get(key);
        if (!b || b.reset <= now) { if (soft.size > 5000) soft.clear(); b = { count: 0, reset: now + windowMs }; soft.set(key, b); }
        return ++b.count <= max;
      }
      const row = await db.get(
        `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
                                        reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END
         RETURNING count`, key, now + windowMs, now, now, now + windowMs);
      if (Math.random() < 0.02) await db.run('DELETE FROM rate_limits WHERE reset_at < ?', now - 60_000); // housekeeping
      return row.count <= max;
    },
    async rateLimitReset(key) { soft.delete(key); await db.run('DELETE FROM rate_limits WHERE key = ?', key); },
    // Encrypts payment-gateway secrets. Best: set APP_SECRET (≥ 32 chars) as a Worker secret — then a copy of the
    // database alone cannot decrypt them. Without it a random key is generated once and kept in the database.
    async getSecretKey() {
      if (secretKey) return secretKey;
      if (env.APP_SECRET && String(env.APP_SECRET).length >= 32) {
        secretKey = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(env.APP_SECRET))));
        return secretKey;
      }
      let row = await db.get("SELECT value FROM kv WHERE key = 'secret_key'");
      if (!row) {
        await db.run("INSERT OR IGNORE INTO kv (key, value) VALUES ('secret_key', ?)", randomHex(32));
        row = await db.get("SELECT value FROM kv WHERE key = 'secret_key'");
      }
      secretKey = Uint8Array.from(row.value.match(/../g), (h) => parseInt(h, 16));
      return secretKey;
    },
    setup: {
      // Anyone could open a brand-new public URL, so the owner may protect the first-run form with SETUP_CODE.
      needsCode: () => !!config.setupCode,
      async expectedCode() { return config.setupCode ? config.setupCode.toUpperCase().replace(/[\s-]/g, '') : null; },
      async done() {},
      codeHint: 'رمز الإعداد غير صحيح (هو قيمة المتغير SETUP_CODE في إعدادات الـ Worker).',
      codeWhere: 'هو قيمة المتغير SETUP_CODE في إعدادات الـ Worker على Cloudflare (Settings ← Variables and Secrets).',
      async pending() { return null; },
    },
    // No dnsLookup: Workers cannot reach private networks, and net.js rejects literal private addresses.
  };
}

let initialised = null; // env bindings are fixed for the life of an isolate

export default {
  async fetch(request, env) {
    if (!env.DB) {
      return new Response('D1 binding "DB" is missing. Deploy with `npx wrangler deploy` (it creates the database) or add a D1 binding named DB in the Worker settings.', { status: 500 });
    }
    if (!initialised) {
      const config = makeConfig({ NODE_ENV: 'production', ...env }, {});
      // 50k PBKDF2 rounds ≈ 8 ms of CPU: fits the 10 ms of the Workers Free plan. Raise PASSWORD_ITERATIONS on the Paid plan.
      config.passwordIterations = Math.max(10_000, Number(env.PASSWORD_ITERATIONS || 50_000));
      const db = d1(env.DB);
      setRuntime({ db, platform: buildPlatform(env, config, db), config });
      initialised = true;
    }
    return handle(request, {});
  },
};
