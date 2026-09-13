-- Wallet controls: freeze (block all spends) + chargeback recovery from upline.
--
-- 1. Freeze: a whole-wallet block. When frozen, NO debit is allowed (all
--    services, transfers, withdrawals) until an admin unfreezes. This is
--    distinct from a lien/hold (wallet_holds), which only blocks a portion.
--
-- 2. Chargeback recovery: when a downline member causes a loss the platform
--    must claw back (a disputed/charged-back transaction), the amount is
--    recovered from the member and any shortfall cascades UP the parent_id
--    chain. The top account (no parent) absorbs the remainder, which may push
--    its balance negative (it owes the platform). To allow that backstop we
--    relax the balance_paise >= 0 CHECK — normal debits still can't go
--    negative because wallet.service.debit() enforces available >= amount in
--    application code; only the explicit chargeback path may cross zero.

ALTER TABLE wallets ADD COLUMN IF NOT EXISTS frozen_at     TIMESTAMPTZ;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS frozen_reason TEXT;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS frozen_by     UUID REFERENCES users(id) ON DELETE SET NULL;

-- Relax the non-negative guard so chargeback recovery can push the backstop
-- account into debt. Application code keeps ordinary debits at/above zero.
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_balance_paise_check;

-- Allow the 'chargeback' ledger source.
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_source_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_source_check
    CHECK (source IN ('topup','dmt','bbps','recharge','payout','payment_gateway','reversal',
        'adjustment','commission','activation_fee','aeps','cms','card_swipe','upi','matm',
        'aadhaar_pay','pan_card','wallet_transfer','travel','insurance','float_transfer',
        'withdrawal','loan','credit_card','chargeback'));

-- Audit trail of chargeback recoveries: one parent row per recovery, plus the
-- per-account legs recorded via wallet_transactions (source='chargeback').
CREATE TABLE IF NOT EXISTS wallet_chargebacks (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    origin_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- member who caused it
    amount_paise   BIGINT NOT NULL CHECK (amount_paise > 0),
    reason         TEXT,
    reference      TEXT,                       -- disputed txn reference, if any
    legs           JSONB NOT NULL DEFAULT '[]', -- [{user_id, amount_paise, went_negative}]
    created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chargebacks_origin_idx ON wallet_chargebacks (origin_user_id, created_at DESC);
