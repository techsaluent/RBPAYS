-- Self-reporting error telemetry: the web panel and the API record their own
-- errors here so the admin can see what's breaking in production and ask the
-- AI Dev Desk to diagnose + draft a fix.
--
-- Rows are grouped by `signature` (a hash of source + message + top stack
-- frame), upserted so a recurring error bumps its count instead of flooding the
-- table. Migration number 071 is picked to sit clear of the in-flight white-
-- label (063–066, 068) and connected-banking (070) branches.

CREATE TABLE IF NOT EXISTS error_reports (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signature        TEXT NOT NULL UNIQUE,                 -- dedupe key
    source           TEXT NOT NULL CHECK (source IN ('web','api')),
    message          TEXT NOT NULL,
    stack            TEXT,
    route            TEXT,                                 -- URL (web) or "METHOD /path" (api)
    release          TEXT,                                 -- app version/build, if sent
    sample_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    sample_user_agent TEXT,
    count            INTEGER NOT NULL DEFAULT 1,
    status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','triaged','resolved','ignored')),
    ai_diagnosis     TEXT,                                 -- AI's explanation
    ai_suggested_fix TEXT,                                 -- AI's proposed change
    ai_model         TEXT,
    escalated_ref    TEXT,                                 -- GitHub issue/PR ref when escalated (Stage 3)
    first_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS error_reports_status_idx ON error_reports (status, last_seen DESC);
CREATE INDEX IF NOT EXISTS error_reports_source_idx ON error_reports (source, last_seen DESC);
