CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  service_slug TEXT NOT NULL,
  resource TEXT NOT NULL,
  accepts_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',      -- open | processing | settled
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_expires ON invoices(expires_at);

CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL UNIQUE,
  service_slug TEXT NOT NULL,
  provider_id TEXT NOT NULL,               -- 'own' for first-party services
  pay_to TEXT NOT NULL,
  payer TEXT,
  asset TEXT NOT NULL,                     -- 'XRP' or 40-hex currency code
  asset_symbol TEXT NOT NULL,              -- 'XRP' | 'RLUSD'
  amount TEXT NOT NULL,                    -- drops for XRP, value string for IOUs
  amount_display TEXT NOT NULL,            -- human units (XRP / RLUSD)
  fee_bps INTEGER NOT NULL DEFAULT 0,
  fee_owed_display TEXT NOT NULL DEFAULT '0',
  network TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settlements_service ON settlements(service_slug);
CREATE INDEX IF NOT EXISTS idx_settlements_provider ON settlements(provider_id);

CREATE TABLE IF NOT EXISTS call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_slug TEXT NOT NULL,
  outcome TEXT NOT NULL,                   -- payment_required | paid | handler_error | verify_failed | settle_failed
  status INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calllog_service ON call_log(service_slug);

-- Secondary feature: third-party listings (marketplace)
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS listed_services (
  slug TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  upstream_url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  price_xrp_drops TEXT,
  price_rlusd TEXT,
  pay_to TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  upstream_secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
