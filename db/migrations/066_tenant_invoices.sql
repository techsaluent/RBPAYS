-- White-label Stage 5: partner billing & settlement.
--
-- Over a period, the platform captures a markup (platform_margin) on every
-- transaction a tenant's network runs. A white-label partner may be on a
-- revenue-share: partner_share_bps (a tenant setting, basis points) of that
-- gross margin is the partner's earning, the remainder is the platform fee.
-- This table is the statement/invoice for one period: compute it as a draft,
-- issue it, then mark it paid when the partner's earning is settled out.
--
-- partner_share_bps defaults to 0 (platform keeps all), so a tenant with no
-- share configured generates a zero-payable statement — existing economics
-- are unchanged until a share is set.

CREATE TABLE IF NOT EXISTS tenant_invoices (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    period_start         DATE NOT NULL,
    period_end           DATE NOT NULL,                 -- inclusive day
    gross_margin_paise   BIGINT NOT NULL DEFAULT 0,     -- net platform_margin on the tenant's txns in the period
    partner_share_bps    INTEGER NOT NULL DEFAULT 0,    -- snapshot of the share at generation time
    partner_earning_paise BIGINT NOT NULL DEFAULT 0,    -- gross_margin * share
    platform_fee_paise   BIGINT NOT NULL DEFAULT 0,     -- gross_margin - partner_earning
    net_payable_paise    BIGINT NOT NULL DEFAULT 0,     -- settled out to the partner (= partner_earning)
    txn_count            INTEGER NOT NULL DEFAULT 0,
    status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','paid','void')),
    reference            TEXT UNIQUE,                   -- human statement no., set on issue
    settlement_ref       TEXT,                          -- how it was paid out (bank ref / wallet credit)
    notes                TEXT,
    issued_at            TIMESTAMPTZ,
    paid_at              TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_invoices_tenant_idx ON tenant_invoices (tenant_id, period_start DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    DROP TRIGGER IF EXISTS trg_tenant_invoices_updated ON tenant_invoices;
    CREATE TRIGGER trg_tenant_invoices_updated BEFORE UPDATE ON tenant_invoices
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
