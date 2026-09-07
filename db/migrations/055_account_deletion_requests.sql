-- Self-serve account deletion requests.
--
-- A member can raise a deletion request from the panel (Profile → Delete my
-- account); it is recorded here for an admin to verify and action, per the
-- public Account & Data Deletion policy. We never hard-delete financial
-- records that must be retained for RBI/PMLA/tax — the admin processes the
-- request accordingly.

CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | processed | rejected
  admin_note    TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  processed_by  UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_deletion_requests_status ON account_deletion_requests (status, created_at DESC);

-- At most one open (pending) request per user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_deletion_requests_open
  ON account_deletion_requests (user_id) WHERE status = 'pending';
