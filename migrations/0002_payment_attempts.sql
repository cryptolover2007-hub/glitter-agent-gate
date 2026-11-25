-- Every request that carried a PAYMENT-SIGNATURE, with the stage it reached and why it failed (or the tx when paid).
CREATE TABLE IF NOT EXISTS payment_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  service_slug TEXT NOT NULL,
  stage TEXT NOT NULL,          -- precheck | verify | handler | settle
  outcome TEXT NOT NULL,        -- invalid_x402_payload | unknown_or_expired_invoice | verify_failed | settle_failed | handler_error_not_charged | paid | ...
  status INTEGER NOT NULL,
  network TEXT, asset TEXT, amount TEXT, payer TEXT, tx_hash TEXT, detail TEXT,
  user_agent TEXT, as_org TEXT, country TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_created ON payment_attempts(created_at);
