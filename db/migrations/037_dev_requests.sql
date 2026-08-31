-- =====================================================================
-- AI Dev Desk — feature / bug / UI requests.
--   A request is filed, the AI drafts a plan of exactly what to build or fix
--   (the "box"), an admin approves it, and it is dispatched to automation
--   (the free-AI coding agent via the automation webhook). No code is written
--   or deployed by this app itself — approval + an external PR stays the gate.
-- =====================================================================
CREATE TABLE IF NOT EXISTS dev_requests (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_no   TEXT UNIQUE,
    kind        TEXT NOT NULL DEFAULT 'feature',   -- feature | bug | ui
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    area        TEXT,                              -- e.g. panel / payout / dashboard
    priority    TEXT NOT NULL DEFAULT 'normal',    -- low | normal | high | urgent
    status      TEXT NOT NULL DEFAULT 'new',       -- new | triaged | approved | dispatched | done | rejected
    ai_plan     JSONB,                             -- the AI-drafted "what to build/fix" box
    remark      TEXT,                              -- approval / rejection note
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dev_requests_status ON dev_requests (status, created_at DESC);

-- Human-friendly ticket number DEV-000001.
CREATE SEQUENCE IF NOT EXISTS dev_requests_seq;
CREATE OR REPLACE FUNCTION set_dev_ticket_no() RETURNS trigger AS $$
BEGIN
    IF NEW.ticket_no IS NULL THEN
        NEW.ticket_no := 'DEV-' || lpad(nextval('dev_requests_seq')::text, 6, '0');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dev_ticket_no ON dev_requests;
CREATE TRIGGER trg_dev_ticket_no BEFORE INSERT ON dev_requests
    FOR EACH ROW EXECUTE FUNCTION set_dev_ticket_no();
