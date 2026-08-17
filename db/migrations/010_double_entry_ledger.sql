-- =====================================================================
-- Double-entry accounting ledger.
--   Every financial movement posts a balanced journal entry:
--   SUM(debit lines) = SUM(credit lines).
-- This runs ALONGSIDE the per-wallet balance model (wallets /
-- wallet_transactions): balances stay the fast source of truth for
-- spending checks, while the journal is the immutable, auditable
-- accounting record the reconciliation / treasury / tax engines build on.
-- =====================================================================

-- ---------- Chart of accounts (account classes) ----------------------
-- Platform-level accounts are singletons; member wallet accounts
-- (member_wallet / settlement_wallet / commission_wallet) are per-user
-- and journal lines carry wallet_user_id to identify the member.
CREATE TABLE IF NOT EXISTS chart_of_accounts (
    code           TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    type           TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
    normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit','credit')),
    per_member     BOOLEAN NOT NULL DEFAULT false,  -- true = lines reference wallet_user_id
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO chart_of_accounts (code, name, type, normal_balance, per_member) VALUES
    ('bank_escrow',            'Bank Settlement / Collection Escrow', 'asset',     'debit',  false),
    ('payout_escrow',          'Bank Payout Escrow',                  'asset',     'debit',  false),
    ('treasury_in_transit',    'Treasury In-Transit Clearing',        'asset',     'debit',  false),
    ('distributor_overdraft',  'Distributor Overdraft Receivable',    'asset',     'debit',  false),
    ('payout_clearing',        'Payout Clearing (In-Transit)',        'liability', 'credit', false),
    ('member_wallet',          'Member Main Wallet',                  'liability', 'credit', true),
    ('settlement_wallet',      'Member AePS Settlement Wallet',       'liability', 'credit', true),
    ('commission_wallet',      'Member Commission Wallet',            'liability', 'credit', true),
    ('tds_payable',            'TDS Payable (194H / 194N)',           'liability', 'credit', false),
    ('gst_output',             'Output GST Payable (CGST/SGST/IGST)', 'liability', 'credit', false),
    ('platform_margin',        'Platform Margin Revenue',             'revenue',   'credit', false),
    ('payout_fee_revenue',     'Payout Fee Revenue',                  'revenue',   'credit', false),
    ('verification_expense',   'Merchant Verification Cost',          'expense',   'debit',  false),
    ('float_incentive_expense','Platform Float Incentive Expense',    'expense',   'debit',  false)
ON CONFLICT (code) DO NOTHING;

-- ---------- Journal entries + lines ----------------------------------
CREATE TABLE IF NOT EXISTS journal_entries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference   TEXT,                       -- transaction / batch reference
    source      TEXT NOT NULL,              -- topup, float_transfer, payout, aeps, ...
    narration   TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS journal_entries_ref_idx ON journal_entries (reference);
CREATE INDEX IF NOT EXISTS journal_entries_src_idx ON journal_entries (source, created_at DESC);

CREATE TABLE IF NOT EXISTS journal_lines (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_id       UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_code   TEXT NOT NULL REFERENCES chart_of_accounts(code),
    wallet_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    direction      TEXT NOT NULL CHECK (direction IN ('debit','credit')),
    amount_paise   BIGINT NOT NULL CHECK (amount_paise > 0),
    narration      TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS journal_lines_entry_idx ON journal_lines (entry_id);
CREATE INDEX IF NOT EXISTS journal_lines_member_idx ON journal_lines (wallet_user_id, account_code, created_at DESC);

-- ---------- Balanced-entry guard (deferred) --------------------------
-- After each entry's lines are inserted, assert debits = credits.
-- Deferred so multiple line inserts within one transaction are checked
-- at COMMIT, not mid-insert.
CREATE OR REPLACE FUNCTION assert_journal_balanced() RETURNS trigger AS $$
DECLARE
  d BIGINT;
  c BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_paise) FILTER (WHERE direction='debit'),0),
         COALESCE(SUM(amount_paise) FILTER (WHERE direction='credit'),0)
    INTO d, c
    FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF d <> c THEN
    RAISE EXCEPTION 'Unbalanced journal entry %: debits % <> credits %', NEW.entry_id, d, c;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_balanced ON journal_lines;
CREATE CONSTRAINT TRIGGER trg_journal_balanced
    AFTER INSERT ON journal_lines
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- ---------- Allow float_transfer as a wallet ledger source -----------
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_source_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_source_check
    CHECK (source IN ('topup','dmt','bbps','recharge','payout','payment_gateway',
                      'reversal','adjustment','commission','activation_fee',
                      'aeps','cms','card_swipe','upi','matm','aadhaar_pay','pan_card',
                      'wallet_transfer','travel','insurance','float_transfer'));
