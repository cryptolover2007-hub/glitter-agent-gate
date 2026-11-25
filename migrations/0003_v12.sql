-- v1.2: caller log merged into payment_attempts (unpaid probes are stage='probe'); kv for the atomic AI daily cap.
ALTER TABLE payment_attempts ADD COLUMN caller_kind TEXT;
CREATE INDEX IF NOT EXISTS idx_attempts_stage ON payment_attempts(stage, created_at);
CREATE TABLE IF NOT EXISTS gate_kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
