-- =====================================================================
-- New commission-bearing services: Travel booking and Insurance.
-- Both are debit-flow (retailer pays, earns commission), like BBPS.
-- =====================================================================

ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_source_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_source_check
    CHECK (source IN ('topup','dmt','bbps','recharge','payout','payment_gateway',
                      'reversal','adjustment','commission','activation_fee',
                      'aeps','cms','card_swipe',
                      'upi','matm','aadhaar_pay','pan_card','wallet_transfer',
                      'travel','insurance'));

INSERT INTO services (code, name) VALUES
    ('travel', 'Travel Booking'),
    ('insurance', 'Insurance')
ON CONFLICT (code) DO NOTHING;

-- ---------- Travel (flight / bus / train / hotel) --------------------
CREATE TABLE IF NOT EXISTS travel_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    booking_type    TEXT NOT NULL CHECK (booking_type IN ('flight','bus','train','hotel')),
    operator        TEXT,                          -- airline / bus operator / hotel
    from_location   TEXT,
    to_location     TEXT,
    travel_date     DATE,
    passenger_name  TEXT,
    amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
    charge_paise    BIGINT NOT NULL DEFAULT 0 CHECK (charge_paise >= 0),
    status          txn_status NOT NULL DEFAULT 'pending',
    provider        TEXT,
    provider_ref    TEXT,
    pnr             TEXT,
    status_message  TEXT,
    reference       TEXT NOT NULL UNIQUE,
    reversed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS travel_user_idx ON travel_transactions (user_id, created_at DESC);

-- ---------- Insurance (policy sale) ----------------------------------
CREATE TABLE IF NOT EXISTS insurance_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    category        TEXT NOT NULL CHECK (category IN ('motor','health','life','travel','personal_accident','other')),
    insurer         TEXT,                          -- insurance company
    customer_name   TEXT,
    policy_number   TEXT,
    amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),  -- premium
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
CREATE INDEX IF NOT EXISTS insurance_user_idx ON insurance_transactions (user_id, created_at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['travel_transactions','insurance_transactions'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- ---------- Rebrand: display name of the seeded admin ----------------
UPDATE users SET full_name = 'TutiPays Admin'
 WHERE email = 'admin@rbpays.in' AND full_name = 'RBPAYS Admin';
