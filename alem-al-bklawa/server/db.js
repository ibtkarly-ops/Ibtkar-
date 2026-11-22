// SQLite access (node:sqlite — bundled with Node, no native build needed) + migrations.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });

export const db = new DatabaseSync(process.env.DB_PATH || path.join(config.dataDir, 'store.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
// node:sqlite only binds null/number/bigint/string/Buffer — normalise everything else.
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

export const all = (sql, ...p) => stmt(sql).all(...p.map(norm)).map((r) => ({ ...r }));
export const get = (sql, ...p) => { const r = stmt(sql).get(...p.map(norm)); return r ? { ...r } : undefined; };
export const run = (sql, ...p) => stmt(sql).run(...p.map(norm));

/** Run fn inside an IMMEDIATE transaction (writers serialised; rolls back on throw). */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

export const nowIso = () => new Date().toISOString();

export function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = path.join(config.root, 'server', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (get('SELECT 1 AS x FROM schema_migrations WHERE name = ?', f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    tx(() => {
      db.exec(sql);
      run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', f, nowIso());
    });
  }
}
