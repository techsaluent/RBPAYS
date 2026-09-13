-- Partner / Reseller API: let members consume TutiPays services programmatically.
--
-- A member (retailer/distributor) generates an API key, integrates against the
-- developer docs, and calls the public /api/v1/partner/* endpoints to fulfil
-- payout, money transfer (DMT), recharge, BBPS, etc. through our platform — a
-- "reselling point". Transactions run as the owning member: their wallet is
-- debited, their commissions apply, their upline settles, exactly as if they'd
-- used the panel. Each key carries scopes (which services it may call), an
-- optional IP allowlist, a per-minute rate limit, and an optional callback URL
-- that receives signed outbound webhooks on terminal settlement.

CREATE TABLE IF NOT EXISTS partner_api_keys (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label              TEXT,
    key_prefix         TEXT NOT NULL,                 -- public, shown in the panel (e.g. pk_live_a1b2c3d4)
    key_hash           TEXT NOT NULL UNIQUE,          -- sha256 of the full raw key; raw shown once
    environment        TEXT NOT NULL DEFAULT 'live' CHECK (environment IN ('live','test')),
    scopes             TEXT[] NOT NULL DEFAULT '{}',  -- service codes the key may call, or {'*'} for all
    allowed_ips        TEXT[] NOT NULL DEFAULT '{}',  -- empty = any IP; else caller IP must be in the list
    rate_limit_per_min INTEGER NOT NULL DEFAULT 120 CHECK (rate_limit_per_min > 0),
    callback_url       TEXT,                          -- optional; receives signed settlement webhooks
    callback_secret    TEXT,                          -- HMAC-SHA256 signing secret for callbacks
    last_used_at       TIMESTAMPTZ,
    revoked_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_keys_user_idx ON partner_api_keys (user_id, created_at DESC);
-- Fast lookup of live keys by hash on every partner request.
CREATE INDEX IF NOT EXISTS partner_keys_active_hash_idx ON partner_api_keys (key_hash) WHERE revoked_at IS NULL;

-- Delivery log for outbound partner callbacks (one row per attempt series per event).
CREATE TABLE IF NOT EXISTS partner_webhook_deliveries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_id          UUID NOT NULL REFERENCES partner_api_keys(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reference       TEXT NOT NULL,
    event           TEXT NOT NULL,                    -- e.g. transaction.success | transaction.failed
    url             TEXT NOT NULL,
    request_body    TEXT,
    response_status INTEGER,
    attempts        INTEGER NOT NULL DEFAULT 0,
    delivered       BOOLEAN NOT NULL DEFAULT false,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_deliveries_key_idx ON partner_webhook_deliveries (key_id, created_at DESC);
-- One delivery per (key, reference, event) so a re-settle / replay never double-posts.
CREATE UNIQUE INDEX IF NOT EXISTS partner_deliveries_dedupe_idx
    ON partner_webhook_deliveries (key_id, reference, event);
