-- Connected Banking: link a corporate/current bank account (directly or via a
-- banking aggregator) so the platform can read its balance + statement, collect
-- into virtual accounts, and fund payouts from it.
--
-- Migration number is reserved at 070 (ahead of the in-flight white-label
-- stages 063–066) so this module merges independently of that chain.
--
-- Money is integer paise (BIGINT), matching the wallet/ledger. Account numbers
-- are stored masked only — full numbers never land in the DB.

-- A connected bank account. owner_user_id NULL = the platform's own account;
-- set = a distributor/partner who connected theirs. driver selects the
-- integration ('manual' = admin-maintained, or a provider driver later).
CREATE TABLE IF NOT EXISTS bank_connections (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    label                 TEXT NOT NULL,
    driver                TEXT NOT NULL DEFAULT 'manual',
    bank_name             TEXT,
    account_name          TEXT,
    account_number_masked TEXT,                 -- e.g. "XXXXXX1234" — masked only
    ifsc                  TEXT,
    balance_paise         BIGINT,               -- last known balance (cache)
    balance_updated_at    TIMESTAMPTZ,
    status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    extra                 JSONB NOT NULL DEFAULT '{}'::jsonb,  -- connection_id / creds ref (no secrets in plaintext)
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A virtual account assigned to a member for collections. Money landing here is
-- auto-credited to that member's wallet.
CREATE TABLE IF NOT EXISTS virtual_accounts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    va_number     TEXT NOT NULL UNIQUE,
    va_ifsc       TEXT,
    upi_handle    TEXT,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS virtual_accounts_user_idx ON virtual_accounts (user_id);

-- Statement lines pulled/pushed from the bank (read model + reconciliation).
CREATE TABLE IF NOT EXISTS bank_statement_entries (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id       UUID NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
    txn_time            TIMESTAMPTZ NOT NULL DEFAULT now(),
    direction           TEXT NOT NULL CHECK (direction IN ('credit','debit')),
    amount_paise        BIGINT NOT NULL CHECK (amount_paise > 0),
    balance_after_paise BIGINT,
    utr                 TEXT,
    counterparty        TEXT,
    narration           TEXT,
    external_id         TEXT,                   -- bank/aggregator line id for dedupe
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (connection_id, external_id)
);
CREATE INDEX IF NOT EXISTS bank_statement_conn_idx ON bank_statement_entries (connection_id, txn_time DESC);

-- Inbound collections (money received into a VA / the account) that fund a
-- member's wallet. One row per bank credit; idempotent on (connection,external).
CREATE TABLE IF NOT EXISTS bank_collections (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id      UUID NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
    virtual_account_id UUID REFERENCES virtual_accounts(id) ON DELETE SET NULL,
    user_id            UUID REFERENCES users(id) ON DELETE SET NULL,  -- credited member (resolved from VA)
    amount_paise       BIGINT NOT NULL CHECK (amount_paise > 0),
    utr                TEXT,
    payer              TEXT,
    external_id        TEXT,
    status             TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','credited','ignored')),
    wallet_reference   UUID,                    -- the wallet credit's reference_id
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (connection_id, external_id)
);
CREATE INDEX IF NOT EXISTS bank_collections_user_idx ON bank_collections (user_id, created_at DESC);

-- Wallet ledger accepts a bank-collection top-up as its own source.
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_source_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_source_check
  CHECK (source = ANY (ARRAY[
    'topup','dmt','bbps','recharge','payout','payment_gateway','reversal','adjustment',
    'commission','activation_fee','aeps','cms','card_swipe','upi','matm','aadhaar_pay',
    'pan_card','wallet_transfer','travel','insurance','float_transfer','withdrawal',
    'loan','credit_card','chargeback','bank_collection']));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    DROP TRIGGER IF EXISTS trg_bank_connections_updated ON bank_connections;
    CREATE TRIGGER trg_bank_connections_updated BEFORE UPDATE ON bank_connections
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
