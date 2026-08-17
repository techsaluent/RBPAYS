-- =====================================================================
-- Statutory tax pipeline (TDS 194H/194N + GST) and multi-wallet model.
--   Main wallet         -> existing `wallets` table (pre-funded balance)
--   Settlement wallet    -> AePS / mATM cash-out inflow (sub_wallets)
--   Commission wallet    -> commission earnings, net of TDS (sub_wallets)
-- =====================================================================

-- ---------- Tax profile per member -----------------------------------
-- Drives the TDS rate: 5% (194H) with a valid PAN of a regular filer,
-- 20% when the PAN is missing/invalid or the member is a 206AB non-filer.
CREATE TABLE IF NOT EXISTS tax_profiles (
    user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    pan                 TEXT,
    pan_name            TEXT,
    pan_valid           BOOLEAN NOT NULL DEFAULT false,
    is_206ab_non_filer  BOOLEAN NOT NULL DEFAULT false,
    gstin               TEXT,
    state_code          TEXT,                 -- GST place-of-supply state code
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Sub-wallets (settlement + commission balances) -----------
CREATE TABLE IF NOT EXISTS sub_wallets (
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wallet_type   TEXT NOT NULL CHECK (wallet_type IN ('settlement','commission')),
    balance_paise BIGINT NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, wallet_type)
);

-- ---------- TDS records (Form 26Q source) ----------------------------
CREATE TABLE IF NOT EXISTS tds_records (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_txn_id UUID,
    service_code   TEXT,
    section        TEXT NOT NULL CHECK (section IN ('194H','194N')),
    gross_paise    BIGINT NOT NULL,
    rate_bps       INT NOT NULL,             -- basis points, e.g. 500 = 5%
    tds_paise      BIGINT NOT NULL,
    net_paise      BIGINT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tds_user_idx ON tds_records (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tds_section_idx ON tds_records (section, created_at DESC);

-- ---------- GST invoices on platform margin --------------------------
CREATE TABLE IF NOT EXISTS gst_invoices (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_txn_id     UUID,
    service_code       TEXT,
    taxable_base_paise BIGINT NOT NULL,
    cgst_paise         BIGINT NOT NULL DEFAULT 0,
    sgst_paise         BIGINT NOT NULL DEFAULT 0,
    igst_paise         BIGINT NOT NULL DEFAULT 0,
    place_of_supply    TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gst_txn_idx ON gst_invoices (service_txn_id);

-- ---------- updated_at triggers --------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['tax_profiles','sub_wallets'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
