// Node.js database adapter: node:sqlite (bundled with Node 22 — no native build) behind the shared async interface.
import { DatabaseSync } from 'node:sqlite';
import { norm } from './dbutil.js';

export function openNodeDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  const cache = new Map();
  const stmt = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  const returnsRows = (sql) => /^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql);
  const exec = (sql, params) => {
    const s = stmt(sql); const p = params.map(norm);
    if (returnsRows(sql)) return { rows: s.all(...p).map((r) => ({ ...r })), changes: 0, lastInsertRowid: 0 };
    const r = s.run(...p);
    return { rows: [], changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  };
  return {
    raw: db,
    async all(sql, ...p) { return exec(sql, p).rows; },
    async get(sql, ...p) { return exec(sql, p).rows[0]; },
    async run(sql, ...p) { const r = exec(sql, p); return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }; },
    // The callback below never awaits, so no other request can interleave: BEGIN…COMMIT is atomic on this connection.
    async batch(list) {
      db.exec('BEGIN IMMEDIATE');
      try { const out = list.map(([sql, ...p]) => exec(sql, p)); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
    },
    close() { db.close(); },
  };
}
