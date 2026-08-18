-- =====================================================================
-- Wallet holds (lien / blocked amount).
--   An admin can block part of a user's wallet so it can't be spent — for a
--   dispute, pending settlement, security or compliance hold. Available
--   balance = wallet balance − SUM(active holds); debits enforce it.
-- =====================================================================
CREATE TABLE IF NOT EXISTS wallet_holds (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    reason       TEXT,
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
    placed_by    UUID REFERENCES users(id),
    released_by  UUID REFERENCES users(id),
    released_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup of a user's active holds (the amount that reduces spendable balance).
CREATE INDEX IF NOT EXISTS idx_wallet_holds_active
  ON wallet_holds (user_id) WHERE status = 'active';
