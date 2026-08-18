-- =====================================================================
-- Wallet withdrawal to bank (agent cash-out).
--   A member (retailer / distributor / MD) moves their own wallet balance to
--   their bank account. On request the wallet is debited into payout_clearing;
--   admin marks it paid (records the UTR) or rejects (refunds the wallet).
-- =====================================================================
CREATE TABLE IF NOT EXISTS wallet_withdrawals (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_paise   BIGINT NOT NULL CHECK (amount_paise > 0),
    account_name   TEXT NOT NULL,
    account_number TEXT NOT NULL,
    ifsc           TEXT NOT NULL,
    mode           TEXT NOT NULL DEFAULT 'IMPS' CHECK (mode IN ('IMPS','NEFT','RTGS')),
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','rejected')),
    utr            TEXT,
    remarks        TEXT,
    reference      TEXT UNIQUE,
    decided_by     UUID REFERENCES users(id),
    decided_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_withdrawals_user ON wallet_withdrawals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_withdrawals_pending ON wallet_withdrawals (created_at) WHERE status = 'pending';

-- Allow 'withdrawal' as a wallet-ledger source.
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_source_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_source_check
  CHECK (source = ANY (ARRAY['topup','dmt','bbps','recharge','payout','payment_gateway','reversal',
    'adjustment','commission','activation_fee','aeps','cms','card_swipe','upi','matm','aadhaar_pay',
    'pan_card','wallet_transfer','travel','insurance','float_transfer','withdrawal']));
