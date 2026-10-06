-- Partner API: an account-level DEFAULT callback URL.
--
-- Per-key callback URLs (partner_api_keys.callback_url) still win. This adds one
-- fallback per member: keys created without their own callback URL deliver to
-- the account default instead, signed with the default's own secret. Lets a
-- reseller point every key at one endpoint without re-entering it each time.

CREATE TABLE IF NOT EXISTS partner_callback_defaults (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    callback_url    TEXT,
    callback_secret TEXT,                 -- HMAC-SHA256 signing secret for this default
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
