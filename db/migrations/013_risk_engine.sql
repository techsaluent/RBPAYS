-- =====================================================================
-- Real-time risk / AML engine event log.
--   Records every risk assessment that raised a flag, its score and the
--   action taken (allow / review / block), plus commission-stripping for
--   split-transaction fee farming.
-- =====================================================================
CREATE TABLE IF NOT EXISTS risk_events (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    service_code TEXT,
    reference    TEXT,
    kind         TEXT NOT NULL,            -- velocity | off_hours | high_amount | aeps_split | dmt_structuring | mule
    score        INT NOT NULL DEFAULT 0,   -- 0..100
    action       TEXT NOT NULL DEFAULT 'allow' CHECK (action IN ('allow','review','hold','block')),
    detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS risk_events_user_idx ON risk_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS risk_events_action_idx ON risk_events (action, created_at DESC);

-- Optional remitter identity for DMT (RBI per-remitter monthly slabs /
-- structuring detection). Nullable so existing rows and flows are unaffected.
ALTER TABLE dmt_transactions ADD COLUMN IF NOT EXISTS remitter_mobile TEXT;
CREATE INDEX IF NOT EXISTS dmt_remitter_idx ON dmt_transactions (remitter_mobile, created_at DESC);
