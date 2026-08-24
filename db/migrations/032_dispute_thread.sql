-- =====================================================================
-- Dispute conversation thread + milestones.
--   A dispute now has a message trail: member/staff comments and status
--   changes (open -> in_review -> resolved/rejected). Each update can notify
--   the member (SMS) and, when a dispute is resolved as a refund, move money.
-- =====================================================================
CREATE TABLE IF NOT EXISTS dispute_messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispute_id  UUID NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
    author_id   UUID REFERENCES users(id),
    author_role TEXT,                          -- retailer | staff | admin | ai | system
    type        TEXT NOT NULL DEFAULT 'comment', -- comment | status_change | resolution | refund
    status_to   TEXT,                          -- set when type = status_change
    message     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dispute_messages_dispute ON dispute_messages (dispute_id, created_at);
