-- 049_rewards.sql
-- Rewards: (1) referral program — members refer others and earn a bonus when
-- the referred member transacts; (2) milestone/prize-draw campaigns — reward
-- members who hit a transaction target with cashback or a lucky draw.

-- ---- Referrals -------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by   UUID REFERENCES users(id);
CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_idx ON users (referral_code) WHERE referral_code IS NOT NULL;
-- Backfill a stable code for every existing user.
UPDATE users SET referral_code = upper(substr(md5(id::text || random()::text), 1, 8))
 WHERE referral_code IS NULL;

CREATE TABLE IF NOT EXISTS referrals (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referred_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rewarded')),
    bonus_paise BIGINT NOT NULL DEFAULT 0,
    rewarded_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals (referrer_id, created_at DESC);

-- Referral bonus (rupees) + on/off, admin-tunable.
INSERT INTO site_settings (key, value) VALUES ('referral_bonus', '50'), ('referral_enabled', 'true')
  ON CONFLICT (key) DO NOTHING;

-- ---- Milestone / prize-draw campaigns -------------------------------------
CREATE TABLE IF NOT EXISTS reward_campaigns (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL,
    metric       TEXT NOT NULL CHECK (metric IN ('count','gtv')),   -- successful txn count | GTV (paise)
    target       BIGINT NOT NULL,                                   -- count OR paise, per `metric`
    from_date    DATE NOT NULL,
    to_date      DATE NOT NULL,
    reward_type  TEXT NOT NULL CHECK (reward_type IN ('cashback','draw')),
    reward_paise BIGINT NOT NULL DEFAULT 0,                         -- cashback per qualifier | prize per winner
    winners      INT NOT NULL DEFAULT 1,                            -- draw: number of winners
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','awarded','closed')),
    created_by   UUID REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    awarded_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS reward_campaigns_created_idx ON reward_campaigns (created_at DESC);

CREATE TABLE IF NOT EXISTS campaign_awards (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id  UUID NOT NULL REFERENCES reward_campaigns(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reward_paise BIGINT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (campaign_id, user_id)
);
