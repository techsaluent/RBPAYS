-- =====================================================================
-- Unified transactions ledger.
-- One row per service transaction across DMT/BBPS/recharge/payout (and
-- payment-gateway top-ups), giving a single history, global idempotency
-- (unique reference), and the source for printable receipts.
--
-- Money model (net commission): the retailer is charged NET of their own
-- commission. net_paise = amount_paise + charge_paise - commission_paise,
-- where commission_paise is the retailer-level commission. Upline commissions
-- (distributor/master_distributor/admin) are credited from platform margin on
-- success; the retailer's commission is realised as the reduced debit.
-- =====================================================================

CREATE TABLE IF NOT EXISTS transactions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    service             TEXT NOT NULL,                 -- dmt|bbps|recharge|payout|payment_gateway
    direction           TEXT NOT NULL DEFAULT 'debit' CHECK (direction IN ('debit','credit')),
    service_txn_id      UUID,                          -- id of the detail row (dmt_transactions, ...)
    reference           TEXT NOT NULL UNIQUE,          -- idempotency key (client ref / Idempotency-Key)
    amount_paise        BIGINT NOT NULL,
    charge_paise        BIGINT NOT NULL DEFAULT 0,
    commission_paise    BIGINT NOT NULL DEFAULT 0,     -- retailer commission (netted into the debit)
    net_paise           BIGINT NOT NULL,               -- actual wallet impact magnitude
    status              txn_status NOT NULL DEFAULT 'pending',
    provider            TEXT,
    status_message      TEXT,
    reversed_at         TIMESTAMPTZ,
    commission_breakdown JSONB,                        -- [{level, beneficiaryId, amountPaise}]
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transactions_user_idx ON transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transactions_service_idx ON transactions (service, created_at DESC);
CREATE INDEX IF NOT EXISTS transactions_status_idx ON transactions (status);

DROP TRIGGER IF EXISTS trg_transactions_updated ON transactions;
CREATE TRIGGER trg_transactions_updated BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
