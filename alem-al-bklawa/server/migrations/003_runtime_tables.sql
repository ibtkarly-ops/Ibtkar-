-- Tables used by the runtime layer (both Node and Cloudflare Workers).
CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Rate limiting counters (used on Workers, where memory is not shared between requests).
CREATE TABLE rate_limits (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- Images uploaded from the admin panel when there is no writable disk (Workers). Stored as base64 text, ≤ 1 MB each.
CREATE TABLE uploads (
  name       TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
