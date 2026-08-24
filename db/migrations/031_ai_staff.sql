-- =====================================================================
-- AI staff / agents alongside human staff.
--   staff_kind distinguishes a human operator from an AI agent. AI agents
--   authenticate with a long-lived, revocable API key (Bearer tpk_...) rather
--   than an interactive password, so an n8n flow / AI agent can act as staff
--   under the same permission model.
-- =====================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_kind TEXT;  -- 'human' | 'ai' (NULL for non-staff)

CREATE TABLE IF NOT EXISTS staff_api_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,   -- sha256 of the raw key (raw never stored)
    label        TEXT,
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_api_tokens_active
  ON staff_api_tokens (user_id) WHERE revoked_at IS NULL;
