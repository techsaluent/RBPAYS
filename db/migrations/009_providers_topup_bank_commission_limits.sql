-- =====================================================================
-- Multi-provider routing, wallet top-up (cash/bank/UPI) with company bank
-- accounts, and per-service commission min/max guardrails.
-- =====================================================================

-- ---------- Company bank accounts (for cash / bank deposit top-ups) ---
-- Super admin adds these; they are shown to master distributors,
-- distributors and retailers so they know where to deposit funds.
CREATE TABLE IF NOT EXISTS company_bank_accounts (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    label          TEXT NOT NULL,                 -- e.g. "HDFC Current — Mumbai"
    bank_name      TEXT NOT NULL,
    account_name   TEXT NOT NULL,                 -- beneficiary / account holder
    account_number TEXT NOT NULL,
    ifsc           TEXT NOT NULL,
    branch         TEXT,
    upi_id         TEXT,                          -- optional UPI/VPA for UPI deposits
    instructions   TEXT,                          -- optional note shown to members
    is_active      BOOLEAN NOT NULL DEFAULT true,
    sort_order     INT NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS company_bank_active_idx ON company_bank_accounts (is_active, sort_order);

-- ---------- Wallet top-up requests -----------------------------------
-- A member requests to load their wallet by depositing money (cash /
-- bank transfer / UPI). Admin verifies the reference (UTR) and approves,
-- which credits the wallet with source='topup'. Card/UPI gateway top-ups
-- that auto-settle can also be recorded here.
CREATE TABLE IF NOT EXISTS wallet_topup_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
    method          TEXT NOT NULL CHECK (method IN ('cash_deposit','bank_transfer','upi','gateway','other')),
    bank_account_id UUID REFERENCES company_bank_accounts(id) ON DELETE SET NULL,
    reference       TEXT,                          -- UTR / transaction reference from the member
    proof_url       TEXT,                          -- optional slip / screenshot
    note            TEXT,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    remarks         TEXT,                          -- admin remarks on approve/reject
    reviewed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     TIMESTAMPTZ,
    wallet_txn_id   UUID,                          -- the credit ledger row once approved
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS topup_user_idx ON wallet_topup_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS topup_status_idx ON wallet_topup_requests (status, created_at DESC);

-- ---------- Service providers (multiple per service) -----------------
-- Super admin registers one or more upstream providers per service and
-- picks the active one. Credentials live here so going live is just
-- "add API keys". `driver` selects the adapter in code
-- (sandbox | aggregator | razorpay | generic).
CREATE TABLE IF NOT EXISTS service_providers (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_code   TEXT NOT NULL REFERENCES services(code) ON DELETE CASCADE,
    label          TEXT NOT NULL,                 -- e.g. "Paysprint", "RazorpayX"
    driver         TEXT NOT NULL DEFAULT 'sandbox'
                     CHECK (driver IN ('sandbox','aggregator','razorpay','generic')),
    base_url       TEXT,
    api_key        TEXT,
    api_secret     TEXT,
    auth_token     TEXT,
    partner_id     TEXT,
    extra          JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active      BOOLEAN NOT NULL DEFAULT false, -- the one used for routing
    priority       INT NOT NULL DEFAULT 0,         -- lower = preferred (for future failover)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_providers_svc_idx ON service_providers (service_code, priority);
-- At most one active provider per service.
CREATE UNIQUE INDEX IF NOT EXISTS service_providers_one_active_idx
    ON service_providers (service_code) WHERE is_active;

-- ---------- Per-service commission guardrails ------------------------
-- Super admin sets the min/max total commission (in paise) a single
-- transaction may distribute for a service; commission-rule saves are
-- validated against these bounds so the network split stays within policy.
ALTER TABLE services ADD COLUMN IF NOT EXISTS min_commission_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN IF NOT EXISTS max_commission_paise BIGINT NOT NULL DEFAULT 9223372036854775807;

-- ---------- updated_at triggers --------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['company_bank_accounts','wallet_topup_requests','service_providers'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
