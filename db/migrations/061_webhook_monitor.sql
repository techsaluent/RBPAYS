-- Webhook monitor: richer audit of inbound provider callbacks.
--
-- provider_events already dedups accepted callbacks by (provider, external_id)
-- and tracks `processed`. This adds the fields the admin monitor needs:
--   reference      — the client reference the callback settled (for lookup)
--   settled_status — the outcome we applied (success | failed | pending)
--   auth_ok        — false for a rejected callback (bad signature / credentials
--                    / missing reference); such rows are logged for forensics
--   error          — why a rejected callback was refused
--   http_status    — the HTTP status we returned to the caller

ALTER TABLE provider_events ADD COLUMN IF NOT EXISTS reference      TEXT;
ALTER TABLE provider_events ADD COLUMN IF NOT EXISTS settled_status TEXT;
ALTER TABLE provider_events ADD COLUMN IF NOT EXISTS auth_ok        BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE provider_events ADD COLUMN IF NOT EXISTS error          TEXT;
ALTER TABLE provider_events ADD COLUMN IF NOT EXISTS http_status    INTEGER;

CREATE INDEX IF NOT EXISTS provider_events_reference_idx ON provider_events (reference);
CREATE INDEX IF NOT EXISTS provider_events_authok_idx ON provider_events (auth_ok) WHERE auth_ok = false;
