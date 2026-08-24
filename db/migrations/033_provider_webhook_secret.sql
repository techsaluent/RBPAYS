-- =====================================================================
-- Per-provider callback secret.
--   Each configured provider gets its own callback URL
--   (/api/v1/webhooks/provider/<id>) and its own signing secret, so several
--   aggregators can post callbacks and each is verified independently.
-- =====================================================================
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS webhook_secret TEXT;
