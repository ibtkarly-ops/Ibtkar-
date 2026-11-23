// Database helpers shared by both runtimes.
//
// Database interface (async; implemented by server/db.js on Node and cloudflare/worker.js on D1):
//   all(sql, ...params)   → rows[]            get(sql, ...params) → row | undefined
//   run(sql, ...params)   → { changes, lastInsertRowid }
//   batch([[sql, ...params], ...]) → [{ rows, changes, lastInsertRowid }]   — executed atomically, in order.
//     Inside a batch, SQLite's changes() / last_insert_rowid() refer to the previous statement, which lets a later
//     statement run only if an earlier one really changed a row (this replaces interactive transactions).

// node:sqlite and D1 bind only null / number / bigint / string — normalise everything else.
export const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

export function splitSql(sql) {
  const cleaned = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  return cleaned.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}

export const nowIso = () => new Date().toISOString();

export async function migrate(db, migrations) {
  await db.run('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set((await db.all('SELECT name FROM schema_migrations')).map((r) => r.name));
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    try {
      await db.batch([
        ...splitSql(m.sql).map((s) => [s]),
        ['INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', m.name, nowIso()],
      ]);
    } catch (e) {
      // Two cold starts can race on the very first request: if the other one finished, we are done.
      if (!(await db.get('SELECT 1 AS x FROM schema_migrations WHERE name = ?', m.name))) throw e;
    }
  }
}

/** Placeholders for an IN (...) list. */
export const qs = (n) => Array.from({ length: n }, () => '?').join(',');
