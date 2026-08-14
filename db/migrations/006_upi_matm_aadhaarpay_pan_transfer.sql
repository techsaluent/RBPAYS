-- =====================================================================
-- Remaining aggregator services + P2P transfer + BBPS billers catalogue.
--   UPI          : debit  (pay to a VPA)
--   Micro ATM    : credit (card cash withdrawal)
--   Aadhaar Pay  : credit (merchant collection via Aadhaar)
--   PAN Card     : debit  (NSDL/UTI application, earning)
--   Wallet xfer  : internal P2P (debit sender, credit receiver)
-- =====================================================================

ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_source_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_source_check
    CHECK (source IN ('topup','dmt','bbps','recharge','payout','payment_gateway',
                      'reversal','adjustment','commission','activation_fee',
                      'aeps','cms','card_swipe',
                      'upi','matm','aadhaar_pay','pan_card','wallet_transfer'));

INSERT INTO services (code, name) VALUES
    ('upi', 'UPI Payout'),
    ('matm', 'Micro ATM'),
    ('aadhaar_pay', 'Aadhaar Pay'),
    ('pan_card', 'PAN Card'),
    ('wallet_transfer', 'Wallet to Wallet Transfer')
ON CONFLICT (code) DO NOTHING;

-- ---------- UPI payout (debit) ---------------------------------------
CREATE TABLE IF NOT EXISTS upi_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    vpa             TEXT NOT NULL,                  -- payee UPI id
    payee_name      TEXT,
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
CREATE INDEX IF NOT EXISTS upi_user_idx ON upi_transactions (user_id, created_at DESC);

-- ---------- Micro ATM (credit) ---------------------------------------
CREATE TABLE IF NOT EXISTS matm_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    card_network    TEXT,
    card_last4      TEXT,
    amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
    charge_paise    BIGINT NOT NULL DEFAULT 0 CHECK (charge_paise >= 0),
    status          txn_status NOT NULL DEFAULT 'pending',
    provider        TEXT,
    provider_ref    TEXT,
    rrn             TEXT,
    status_message  TEXT,
    reference       TEXT NOT NULL UNIQUE,
    reversed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS matm_user_idx ON matm_transactions (user_id, created_at DESC);

-- ---------- Aadhaar Pay (credit) -------------------------------------
CREATE TABLE IF NOT EXISTS aadhaar_pay_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    aadhaar_ref     TEXT,
    bank_iin        TEXT,
    mobile          TEXT,
    amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
    charge_paise    BIGINT NOT NULL DEFAULT 0 CHECK (charge_paise >= 0),
    status          txn_status NOT NULL DEFAULT 'pending',
    provider        TEXT,
    provider_ref    TEXT,
    rrn             TEXT,
    status_message  TEXT,
    reference       TEXT NOT NULL UNIQUE,
    reversed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aadhaar_pay_user_idx ON aadhaar_pay_transactions (user_id, created_at DESC);

-- ---------- PAN Card (debit) -----------------------------------------
CREATE TABLE IF NOT EXISTS pan_card_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    application_type TEXT NOT NULL DEFAULT 'new' CHECK (application_type IN ('new','correction')),
    portal          TEXT DEFAULT 'nsdl' CHECK (portal IN ('nsdl','uti')),
    applicant_name  TEXT NOT NULL,
    pan_number      TEXT,
    amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
    charge_paise    BIGINT NOT NULL DEFAULT 0 CHECK (charge_paise >= 0),
    status          txn_status NOT NULL DEFAULT 'pending',
    provider        TEXT,
    provider_ref    TEXT,
    ack_number      TEXT,
    status_message  TEXT,
    reference       TEXT NOT NULL UNIQUE,
    reversed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pan_card_user_idx ON pan_card_transactions (user_id, created_at DESC);

-- ---------- Wallet-to-wallet (P2P) transfer --------------------------
CREATE TABLE IF NOT EXISTS wallet_transfers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    receiver_id     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
    charge_paise    BIGINT NOT NULL DEFAULT 0 CHECK (charge_paise >= 0),
    note            TEXT,
    status          txn_status NOT NULL DEFAULT 'success',
    reference       TEXT NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_transfers_sender_idx ON wallet_transfers (sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_transfers_receiver_idx ON wallet_transfers (receiver_id, created_at DESC);

-- ---------- BBPS billers catalogue -----------------------------------
-- Fastag, insurance, LPG, electricity, credit-card, loan, etc. are all BBPS
-- biller categories — this catalogue makes them discoverable via /bbps/billers.
CREATE TABLE IF NOT EXISTS billers (
    biller_id   TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,
    coverage    TEXT,                               -- national / state
    enabled     BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billers_category_idx ON billers (category);

INSERT INTO billers (biller_id, name, category, coverage) VALUES
    ('ELEC-MSEB',   'MSEB Electricity',        'electricity',  'state'),
    ('ELEC-BESCOM', 'BESCOM Electricity',      'electricity',  'state'),
    ('GAS-IGL',     'Indraprastha Gas',        'gas',          'state'),
    ('LPG-INDANE',  'Indane LPG',              'lpg',          'national'),
    ('WATER-DJB',   'Delhi Jal Board',         'water',        'state'),
    ('BROAD-ACT',   'ACT Broadband',           'broadband',    'state'),
    ('DTH-TATA',    'Tata Play DTH',           'dth',          'national'),
    ('FASTAG-NHAI', 'NHAI FASTag',             'fastag',       'national'),
    ('INS-LIC',     'LIC of India',            'insurance',    'national'),
    ('LOAN-BAJAJ',  'Bajaj Finance Loan EMI',  'loan',         'national'),
    ('CC-HDFC',     'HDFC Credit Card',        'credit_card',  'national'),
    ('MUN-BBMP',    'BBMP Municipal Tax',      'municipal',    'state'),
    ('EDU-BYJUS',   'Education Fees',          'education',    'national')
ON CONFLICT (biller_id) DO NOTHING;

-- updated_at triggers.
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['upi_transactions','matm_transactions',
                               'aadhaar_pay_transactions','pan_card_transactions'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
