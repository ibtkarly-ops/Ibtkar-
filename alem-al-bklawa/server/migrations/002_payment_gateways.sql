-- Payment gateways are configured from the admin panel (no code / env changes).
-- `config` holds non-secret settings (JSON). `secrets` is AES-256-GCM encrypted JSON (API keys, tokens, webhook secrets).
CREATE TABLE payment_gateways (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  label      TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0,
  mode       TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('test','live')),
  config     TEXT NOT NULL DEFAULT '{}',
  secrets    TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

ALTER TABLE payments ADD COLUMN gateway_id INTEGER REFERENCES payment_gateways(id) ON DELETE SET NULL;
CREATE INDEX idx_payments_gateway ON payments(gateway_id);
