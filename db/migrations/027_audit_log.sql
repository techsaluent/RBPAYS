-- =====================================================================
-- Admin / staff activity audit log.
--   An append-only trail of sensitive back-office actions: who did what, to
--   which target, with the remark/details. Powers accountability now that
--   staff can act and every approval carries a remark.
-- =====================================================================
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id    UUID REFERENCES users(id),
    actor_role  TEXT,
    action      TEXT NOT NULL,          -- e.g. kyc.review, topup.approve, hold.place
    target_type TEXT,                   -- user | kyc | topup | hold | staff | provider | ...
    target_id   TEXT,
    detail      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- remark, amounts, status, etc.
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit_log (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_log (action, created_at DESC);
