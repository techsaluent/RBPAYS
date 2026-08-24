-- =====================================================================
-- Duplicate-transaction guard.
--   Blocks an identical transaction (same member + service + amount +
--   details) from being submitted again inside a configurable window.
--   The window (minutes) is set by the admin — 0 disables the guard.
-- =====================================================================
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dedupe_hash TEXT;

-- Fast lookup of a member's recent identical attempts.
CREATE INDEX IF NOT EXISTS idx_transactions_dedupe
    ON transactions (user_id, dedupe_hash, created_at)
    WHERE dedupe_hash IS NOT NULL;

-- Admin-configurable window in minutes (default 5, 0 = off).
INSERT INTO site_settings (key, value)
VALUES ('duplicate_txn_window_minutes', '5')
ON CONFLICT (key) DO NOTHING;
