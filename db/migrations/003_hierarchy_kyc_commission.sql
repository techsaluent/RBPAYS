-- =====================================================================
-- Distribution hierarchy, KYC, service activation, and commissions.
--   admin > master_distributor > distributor > retailer > user
-- Each member has a parent (who onboarded them) and a commission plan.
-- =====================================================================

-- ---------- Expand user roles + hierarchy ----------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('user','retailer','distributor','master_distributor','admin','agent'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_plan_id UUID;
ALTER TABLE users ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS users_parent_idx ON users (parent_id);
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);

-- Allow commission credits in the wallet ledger.
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_source_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_source_check
    CHECK (source IN ('topup','dmt','bbps','recharge','payout','payment_gateway',
                      'reversal','adjustment','commission','activation_fee'));

-- ---------- KYC documents --------------------------------------------
CREATE TABLE IF NOT EXISTS kyc_documents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doc_type      TEXT NOT NULL CHECK (doc_type IN ('aadhaar','pan','gst','shop_photo','bank_proof','selfie','other')),
    doc_number    TEXT,
    file_url      TEXT,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
    remarks       TEXT,
    reviewed_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kyc_user_idx ON kyc_documents (user_id);
CREATE INDEX IF NOT EXISTS kyc_status_idx ON kyc_documents (status);

-- ---------- Services catalogue ---------------------------------------
CREATE TABLE IF NOT EXISTS services (
    code                  TEXT PRIMARY KEY,          -- dmt, bbps, recharge, payout, payment_gateway
    name                  TEXT NOT NULL,
    enabled               BOOLEAN NOT NULL DEFAULT true,   -- global on/off
    activation_charge_paise BIGINT NOT NULL DEFAULT 0,     -- one-time fee to activate for a member
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO services (code, name) VALUES
    ('dmt', 'Domestic Money Transfer'),
    ('bbps', 'Bharat Bill Payment'),
    ('recharge', 'Mobile / DTH Recharge'),
    ('payout', 'Payout'),
    ('payment_gateway', 'Payment Gateway')
ON CONFLICT (code) DO NOTHING;

-- Per-member service activation.
CREATE TABLE IF NOT EXISTS user_services (
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_code  TEXT NOT NULL REFERENCES services(code) ON DELETE CASCADE,
    active        BOOLEAN NOT NULL DEFAULT true,
    activated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, service_code)
);

-- ---------- Commission plans + slab rules ----------------------------
CREATE TABLE IF NOT EXISTS commission_plans (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    is_default  BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- users.commission_plan_id -> commission_plans.id (added as FK now that table exists)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_commission_plan_fk;
ALTER TABLE users ADD CONSTRAINT users_commission_plan_fk
    FOREIGN KEY (commission_plan_id) REFERENCES commission_plans(id) ON DELETE SET NULL;

-- A rule = for a plan+service+amount slab: the customer charge and the
-- commission each level earns. type='flat' means a rupee amount; type='percent'
-- means a percentage of the transaction amount. Flat values are in rupees.
CREATE TABLE IF NOT EXISTS commission_rules (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id                UUID NOT NULL REFERENCES commission_plans(id) ON DELETE CASCADE,
    service_code           TEXT NOT NULL REFERENCES services(code) ON DELETE CASCADE,
    min_amount_paise       BIGINT NOT NULL DEFAULT 0,
    max_amount_paise       BIGINT NOT NULL DEFAULT 9223372036854775807,  -- effectively infinity
    charge_type            TEXT NOT NULL DEFAULT 'flat' CHECK (charge_type IN ('flat','percent')),
    charge_value           NUMERIC(12,4) NOT NULL DEFAULT 0,
    retailer_type          TEXT NOT NULL DEFAULT 'flat' CHECK (retailer_type IN ('flat','percent')),
    retailer_value         NUMERIC(12,4) NOT NULL DEFAULT 0,
    distributor_type       TEXT NOT NULL DEFAULT 'flat' CHECK (distributor_type IN ('flat','percent')),
    distributor_value      NUMERIC(12,4) NOT NULL DEFAULT 0,
    master_distributor_type  TEXT NOT NULL DEFAULT 'flat' CHECK (master_distributor_type IN ('flat','percent')),
    master_distributor_value NUMERIC(12,4) NOT NULL DEFAULT 0,
    admin_type             TEXT NOT NULL DEFAULT 'flat' CHECK (admin_type IN ('flat','percent')),
    admin_value            NUMERIC(12,4) NOT NULL DEFAULT 0,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commission_rules_lookup_idx
    ON commission_rules (plan_id, service_code, min_amount_paise, max_amount_paise);

-- ---------- Commission ledger (distributed earnings) -----------------
CREATE TABLE IF NOT EXISTS commission_entries (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_txn_id    UUID NOT NULL,                 -- id of the dmt/bbps/... row
    service_code      TEXT NOT NULL,
    performer_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    beneficiary_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    level             TEXT NOT NULL CHECK (level IN ('retailer','distributor','master_distributor','admin')),
    amount_paise      BIGINT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- one entry per (transaction, level) — makes distribution idempotent
    UNIQUE (service_txn_id, level)
);
CREATE INDEX IF NOT EXISTS commission_entries_beneficiary_idx ON commission_entries (beneficiary_id, created_at DESC);
CREATE INDEX IF NOT EXISTS commission_entries_txn_idx ON commission_entries (service_txn_id);

-- ---------- updated_at triggers for new tables -----------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['kyc_documents','services','commission_plans'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
