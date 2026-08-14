-- =====================================================================
-- New services: AEPS, CMS and Card Swipe — all commission-bearing.
--
-- Flow types (see _shared/transaction.ts):
--   debit  : net_debit  = amount + charge - retailer_commission   (CMS, like BBPS)
--   credit : net_credit = amount + retailer_commission - charge   (AEPS, Card Swipe)
--
--   - AEPS       : retailer EARNS commission (charge usually 0) -> wallet credited amount + comm
--   - Card Swipe : retailer is CHARGED the MDR (charge > 0)     -> wallet credited amount - MDR
-- =====================================================================

-- Allow the new wallet ledger sources.
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_source_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_source_check
    CHECK (source IN ('topup','dmt','bbps','recharge','payout','payment_gateway',
                      'reversal','adjustment','commission','activation_fee',
                      'aeps','cms','card_swipe'));

-- Catalogue entries.
INSERT INTO services (code, name) VALUES
    ('aeps', 'Aadhaar Enabled Payment System'),
    ('cms', 'Cash Management Services'),
    ('card_swipe', 'Card Swipe (mPOS)')
ON CONFLICT (code) DO NOTHING;

-- ---------- AEPS (credit / earning) ----------------------------------
CREATE TABLE IF NOT EXISTS aeps_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    txn_type        TEXT NOT NULL CHECK (txn_type IN ('cash_withdrawal','balance_enquiry','mini_statement')),
    aadhaar_ref     TEXT,                          -- masked / reference, never store full biometric
    bank_iin        TEXT,                          -- issuer identification number
    bank_name       TEXT,
    mobile          TEXT,
    amount_paise    BIGINT NOT NULL DEFAULT 0 CHECK (amount_paise >= 0),
    charge_paise    BIGINT NOT NULL DEFAULT 0 CHECK (charge_paise >= 0),
    balance_paise   BIGINT,                         -- result of a balance enquiry
    status          txn_status NOT NULL DEFAULT 'pending',
    provider        TEXT,
    provider_ref    TEXT,
    rrn             TEXT,                           -- retrieval reference number
    status_message  TEXT,
    reference       TEXT NOT NULL UNIQUE,
    reversed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aeps_user_idx ON aeps_transactions (user_id, created_at DESC);

-- ---------- CMS (debit / collection, like BBPS) ----------------------
CREATE TABLE IF NOT EXISTS cms_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    agent_id        TEXT NOT NULL,                  -- company / biller code
    biller_name     TEXT,
    account_number  TEXT NOT NULL,                  -- loan / customer account
    customer_name   TEXT,
    amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
    charge_paise    BIGINT NOT NULL DEFAULT 0 CHECK (charge_paise >= 0),
    status          txn_status NOT NULL DEFAULT 'pending',
    provider        TEXT,
    provider_ref    TEXT,
    status_message  TEXT,
    reference       TEXT NOT NULL UNIQUE,
    reversed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cms_user_idx ON cms_transactions (user_id, created_at DESC);

-- ---------- Card Swipe (credit, retailer charged MDR) ----------------
CREATE TABLE IF NOT EXISTS card_swipe_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    card_network    TEXT,                           -- visa / mastercard / rupay / amex
    card_type       TEXT CHECK (card_type IN ('credit','debit')),
    card_last4      TEXT,
    amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
    charge_paise    BIGINT NOT NULL DEFAULT 0 CHECK (charge_paise >= 0),  -- MDR charged to retailer
    status          txn_status NOT NULL DEFAULT 'pending',
    provider        TEXT,
    provider_ref    TEXT,
    rrn             TEXT,
    auth_code       TEXT,
    tid             TEXT,                           -- terminal id
    status_message  TEXT,
    reference       TEXT NOT NULL UNIQUE,
    reversed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS card_swipe_user_idx ON card_swipe_transactions (user_id, created_at DESC);

-- updated_at triggers.
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['aeps_transactions','cms_transactions','card_swipe_transactions'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
