-- =====================================================================
-- RBPAYS core schema
-- Money is stored as BIGINT in paise (minor units) to avoid float error.
-- 1 INR = 100 paise.  Never store money as float/double.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ---------- Users ----------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name       TEXT        NOT NULL,
    email           TEXT        NOT NULL,
    phone           TEXT        NOT NULL UNIQUE,
    password_hash   TEXT        NOT NULL,
    role            TEXT        NOT NULL DEFAULT 'user'
                                CHECK (role IN ('user', 'agent', 'admin')),
    status          TEXT        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'suspended', 'blocked')),
    kyc_status      TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (kyc_status IN ('pending', 'verified', 'rejected')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive unique email (CITEXT avoided to keep zero extra extensions).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uniq ON users (lower(email));

-- ---------- Refresh tokens (rotating) --------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL,                 -- sha256 of the token
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_hash_idx ON refresh_tokens (token_hash);

-- ---------- Wallets --------------------------------------------------
-- One primary wallet per user. Balance in paise. Never update balance
-- outside a wallet_transactions ledger entry (see wallet.service.ts).
CREATE TABLE IF NOT EXISTS wallets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    balance_paise   BIGINT NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
    currency        TEXT   NOT NULL DEFAULT 'INR',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Wallet ledger (double-entry style single-account) --------
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id          UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    direction          TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
    amount_paise       BIGINT NOT NULL CHECK (amount_paise > 0),
    balance_after_paise BIGINT NOT NULL,
    -- What caused this ledger movement
    source             TEXT NOT NULL
                        CHECK (source IN ('topup','dmt','bbps','recharge','payout','payment_gateway','reversal','adjustment')),
    reference_id       UUID,                        -- id of the source txn row
    description        TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_txn_wallet_idx ON wallet_transactions (wallet_id, created_at DESC);

-- ---------- Beneficiaries (used by DMT & Payout) ---------------------
CREATE TABLE IF NOT EXISTS beneficiaries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    account_number  TEXT NOT NULL,
    ifsc            TEXT NOT NULL,
    bank_name       TEXT,
    is_verified     BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, account_number, ifsc)
);
CREATE INDEX IF NOT EXISTS beneficiaries_user_idx ON beneficiaries (user_id);

-- ---------- Common txn status ----------------------------------------
-- All service transactions share this lifecycle:
--   pending -> success | failed | refunded
DO $$ BEGIN
    CREATE DOMAIN txn_status AS TEXT
        CHECK (VALUE IN ('pending', 'success', 'failed', 'refunded'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- DMT (Domestic Money Transfer) ----------------------------
CREATE TABLE IF NOT EXISTS dmt_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    beneficiary_id  UUID REFERENCES beneficiaries(id) ON DELETE SET NULL,
    beneficiary_name    TEXT NOT NULL,
    account_number  TEXT NOT NULL,
    ifsc            TEXT NOT NULL,
    amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
    charge_paise    BIGINT NOT NULL DEFAULT 0 CHECK (charge_paise >= 0),
    mode            TEXT NOT NULL DEFAULT 'IMPS' CHECK (mode IN ('IMPS','NEFT','RTGS')),
    status          txn_status NOT NULL DEFAULT 'pending',
    provider_ref    TEXT,
    utr             TEXT,
    reference       TEXT NOT NULL UNIQUE,          -- client/internal idempotency ref
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dmt_user_idx ON dmt_transactions (user_id, created_at DESC);

-- ---------- BBPS (Bharat Bill Payment System) ------------------------
CREATE TABLE IF NOT EXISTS bbps_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    biller_id       TEXT NOT NULL,
    biller_name     TEXT,
    category        TEXT,                          -- Electricity, Gas, Water, DTH, ...
    consumer_number TEXT NOT NULL,
    amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
    charge_paise    BIGINT NOT NULL DEFAULT 0 CHECK (charge_paise >= 0),
    status          txn_status NOT NULL DEFAULT 'pending',
    provider_ref    TEXT,
    reference       TEXT NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bbps_user_idx ON bbps_transactions (user_id, created_at DESC);

-- ---------- Recharge (Mobile / DTH) ----------------------------------
CREATE TABLE IF NOT EXISTS recharge_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    operator        TEXT NOT NULL,
    circle          TEXT,
    recharge_type   TEXT NOT NULL DEFAULT 'prepaid'
                    CHECK (recharge_type IN ('prepaid','postpaid','dth')),
    number          TEXT NOT NULL,                 -- mobile / DTH subscriber id
    amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
    charge_paise    BIGINT NOT NULL DEFAULT 0 CHECK (charge_paise >= 0),
    status          txn_status NOT NULL DEFAULT 'pending',
    provider_ref    TEXT,
    reference       TEXT NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recharge_user_idx ON recharge_transactions (user_id, created_at DESC);

-- ---------- Payout (bank disbursement) -------------------------------
CREATE TABLE IF NOT EXISTS payout_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    beneficiary_id  UUID REFERENCES beneficiaries(id) ON DELETE SET NULL,
    beneficiary_name    TEXT NOT NULL,
    account_number  TEXT NOT NULL,
    ifsc            TEXT NOT NULL,
    amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
    charge_paise    BIGINT NOT NULL DEFAULT 0 CHECK (charge_paise >= 0),
    mode            TEXT NOT NULL DEFAULT 'IMPS' CHECK (mode IN ('IMPS','NEFT','RTGS','UPI')),
    status          txn_status NOT NULL DEFAULT 'pending',
    provider_ref    TEXT,
    utr             TEXT,
    reference       TEXT NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payout_user_idx ON payout_transactions (user_id, created_at DESC);

-- ---------- Payment Gateway (collection / topup) ---------------------
CREATE TABLE IF NOT EXISTS pg_orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    gateway         TEXT NOT NULL DEFAULT 'razorpay',   -- razorpay, cashfree, ...
    amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
    currency        TEXT NOT NULL DEFAULT 'INR',
    purpose         TEXT NOT NULL DEFAULT 'wallet_topup',
    status          txn_status NOT NULL DEFAULT 'pending',
    gateway_order_id    TEXT,
    gateway_payment_id  TEXT,
    reference       TEXT NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pg_orders_user_idx ON pg_orders (user_id, created_at DESC);

-- ---------- updated_at trigger ---------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['users','wallets','dmt_transactions','bbps_transactions',
                               'recharge_transactions','payout_transactions','pg_orders'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
