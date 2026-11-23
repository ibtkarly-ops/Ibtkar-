// Site settings (editable from the admin panel) + first-run seed. Async: works on SQLite and D1.
import { rt } from './runtime.js';
import { nowIso } from './dbutil.js';
import { DEFAULTS, PUBLIC_KEYS } from './defaults.js';

export { DEFAULTS, PUBLIC_KEYS };

// Short TTL cache: a Worker isolate (or Node process) re-reads settings at most every few seconds,
// and saving settings invalidates the cache immediately in the instance that saved them.
let cache = null; let cacheAt = 0; const TTL = 5000;
export const resetSettingsCache = () => { cache = null; };

export async function getSettings() {
  if (cache && Date.now() - cacheAt < TTL) return cache;
  const out = { ...DEFAULTS };
  for (const r of await rt.db.all('SELECT key, value FROM site_settings')) {
    if (r.key in DEFAULTS) { try { out[r.key] = JSON.parse(r.value); } catch { /* keep default */ } }
  }
  cache = out; cacheAt = Date.now();
  return out;
}

export async function saveSettings(patch) {
  const stmts = Object.entries(patch).filter(([k]) => k in DEFAULTS).map(([k, v]) => [
    `INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, k, JSON.stringify(v), nowIso()]);
  if (stmts.length) await rt.db.batch(stmts);
  cache = null;
}

/** The logo actually in use: one uploaded from the admin panel, else the file shipped with the app, else ''. */
export const effectiveLogo = (settings) => settings.logo_url || rt.platform.defaultLogo || '';

/** Real data the owner gave us: category names, branch names, the Souq Al-Jumaa phone. No products. */
export async function seedIfEmpty() {
  const { db } = rt;
  // Seed once per database (not on every cold start), so anything the owner later deletes stays deleted.
  if (await db.get("SELECT 1 AS x FROM kv WHERE key = 'seeded'")) return;
  if (!(await db.get('SELECT 1 AS x FROM categories LIMIT 1'))) {
    const cats = [['bklawa', 'بكلاوه', 'products'], ['juice', 'عصير', 'products'], ['sweets', 'حلويات', 'products'], ['other', 'منتجات أخرى', 'products'], ['bundles', 'باقات المناسبات', 'bundles']];
    await db.batch(cats.map(([slug, name, kind], i) => ['INSERT OR IGNORE INTO categories (slug, name, kind, sort_order) VALUES (?, ?, ?, ?)', slug, name, kind, (i + 1) * 10]));
  }
  if (!(await db.get('SELECT 1 AS x FROM branches LIMIT 1'))) {
    await db.batch([
      ['INSERT OR IGNORE INTO branches (slug, name, phone, whatsapp, sort_order) VALUES (?, ?, ?, ?, ?)', 'souq-al-jumaa', 'سوق الجمعة', '0925006674', '218925006674', 10],
      ['INSERT OR IGNORE INTO branches (slug, name, sort_order) VALUES (?, ?, ?)', 'nofleen', 'النوفليين', 20],
      ['INSERT OR IGNORE INTO branches (slug, name, sort_order) VALUES (?, ?, ?)', 'al-siraj', 'السراج', 30],
    ]);
  }
  await db.run("INSERT OR IGNORE INTO kv (key, value) VALUES ('seeded', ?)", nowIso());
}
