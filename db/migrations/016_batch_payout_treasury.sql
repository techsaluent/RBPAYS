-- =====================================================================
-- Automated batch payout engine + treasury liquidity view.
--   Settlement-wallet balances are disbursed to bank accounts in NEFT/RTGS
--   batches; funds are held in the payout_clearing account in-transit and
--   only leave the payout escrow when the bank confirms (reverse feed).
-- =====================================================================
CREATE TABLE IF NOT EXISTS payout_batches (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    label         TEXT NOT NULL,
    rail          TEXT NOT NULL DEFAULT 'mixed',   -- NEFT | RTGS | mixed
    total_paise   BIGINT NOT NULL DEFAULT 0,
    record_count  INT NOT NULL DEFAULT 0,
    settled_count INT NOT NULL DEFAULT 0,
    returned_count INT NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','transmitted','settled','aborted')),
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payout_batch_records (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id         UUID NOT NULL REFERENCES payout_batches(id) ON DELETE CASCADE,
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_paise     BIGINT NOT NULL CHECK (amount_paise > 0),
    rail             TEXT NOT NULL,                -- NEFT | RTGS
    beneficiary_name TEXT NOT NULL,
    account_number   TEXT NOT NULL,
    ifsc             TEXT NOT NULL,
    seq              INT NOT NULL,                 -- record sequence in the batch
    status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','settled','returned')),
    utr              TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payout_records_batch_idx ON payout_batch_records (batch_id);
