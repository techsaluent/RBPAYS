-- =====================================================================
-- Transaction disputes / complaints.
--   A member (or the customer, via the member) raises a dispute on a
--   transaction; admin/staff track it by the platform reference id and
--   resolve it. Also stores an optional n8n / automation webhook URL so
--   dispute events can drive external workflows (n8n, AI-agent staff, etc).
-- =====================================================================
CREATE TABLE IF NOT EXISTS disputes (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_no      TEXT UNIQUE,                 -- short human ref, e.g. DSP-XXXXXXXX
    reference      TEXT,                        -- platform transaction reference (searchable)
    transaction_id UUID REFERENCES transactions(id),
    raised_by      UUID NOT NULL REFERENCES users(id),
    category       TEXT NOT NULL,               -- not_credited | wrong_amount | double_charge | service_failed | other
    description    TEXT NOT NULL,
    customer_ref   TEXT,                         -- optional customer phone/name for context
    status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_review','resolved','rejected')),
    assigned_to    UUID REFERENCES users(id),
    resolution     TEXT,
    resolved_by    UUID REFERENCES users(id),
    resolved_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_disputes_reference ON disputes (reference);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_disputes_raised_by ON disputes (raised_by, created_at DESC);

DROP TRIGGER IF EXISTS trg_disputes_updated ON disputes;
CREATE TRIGGER trg_disputes_updated BEFORE UPDATE ON disputes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
