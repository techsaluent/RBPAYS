-- =====================================================================
-- Per-provider routing & commission.
--   A service can have several active providers (e.g. Recharge 1 / Recharge 2).
--   The retailer may pick one at transaction time; commission can be set per
--   provider. A rule with provider_id = NULL is the service-wide default.
-- =====================================================================

-- Commission rules may target a specific provider (NULL = default for service).
ALTER TABLE commission_rules
  ADD COLUMN IF NOT EXISTS provider_id UUID REFERENCES service_providers(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_commission_rules_provider
  ON commission_rules (plan_id, service_code, provider_id);

-- Record which provider actually handled a transaction (for routing + reports).
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS provider_id UUID REFERENCES service_providers(id);

-- Allow MORE THAN ONE active provider per service (e.g. Recharge 1 + Recharge 2).
-- The old unique index permitted a single active provider per service; drop it.
DROP INDEX IF EXISTS service_providers_one_active_idx;

