-- =====================================================================
-- Loan repayment + Credit-card bill payment services.
--   Both are debit / earning services (retailer collects a payment and earns
--   commission), settled through the shared orchestrator like BBPS.
-- =====================================================================
INSERT INTO services (code, name) VALUES
    ('loan', 'Loan Repayment'),
    ('credit_card', 'Credit Card Bill Payment')
ON CONFLICT (code) DO NOTHING;

-- The wallet ledger source is CHECK-constrained; allow the two new services.
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_source_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_source_check
    CHECK (source IN ('topup','dmt','bbps','recharge','payout','payment_gateway','reversal',
        'adjustment','commission','activation_fee','aeps','cms','card_swipe','upi','matm',
        'aadhaar_pay','pan_card','wallet_transfer','travel','insurance','float_transfer',
        'withdrawal','loan','credit_card'));

CREATE TABLE IF NOT EXISTS loan_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    lender          TEXT,                          -- NBFC / bank name
    loan_account_no TEXT NOT NULL,
    customer_name   TEXT,
    amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
    charge_paise    BIGINT NOT NULL DEFAULT 0 CHECK (charge_paise >= 0),
    status          txn_status NOT NULL DEFAULT 'pending',
    provider        TEXT,
    provider_ref    TEXT,
    utr             TEXT,
    status_message  TEXT,
    reference       TEXT NOT NULL UNIQUE,
    reversed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_card_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    issuer          TEXT,                          -- card-issuing bank
    card_number     TEXT NOT NULL,                 -- masked / full as provider needs
    customer_name   TEXT,
    amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
    charge_paise    BIGINT NOT NULL DEFAULT 0 CHECK (charge_paise >= 0),
    status          txn_status NOT NULL DEFAULT 'pending',
    provider        TEXT,
    provider_ref    TEXT,
    utr             TEXT,
    status_message  TEXT,
    reference       TEXT NOT NULL UNIQUE,
    reversed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
