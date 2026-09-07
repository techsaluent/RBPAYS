-- Provider Connections: group service_providers rows that share ONE credential
-- set across many services.
--
-- Many aggregators (e.g. Eko) expose several services — DMT, AEPS, BBPS,
-- recharge — behind a single API credential. Rather than pasting the same keys
-- into a separate provider row per service, a "connection" is created once and
-- fanned out to one service_providers row per selected service, all tagged with
-- the same connection_id so the admin manages them as a single unit. The
-- runtime is unchanged — it still routes per service via the active row.

ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS connection_id UUID;
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS connection_label TEXT;

CREATE INDEX IF NOT EXISTS idx_service_providers_connection ON service_providers (connection_id);
