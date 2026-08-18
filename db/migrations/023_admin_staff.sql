-- =====================================================================
-- Admin staff team with scoped permissions.
--   Adds a 'staff' role: back-office operators who log in through the admin
--   console but only see/act on the sections the super admin grants them.
--   Permissions are individual grants in staff_permissions; the super admin
--   ('admin' role) implicitly holds every permission.
-- =====================================================================

-- 1) Allow the new 'staff' role on users.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role = ANY (ARRAY['user','retailer','distributor','master_distributor','admin','agent','staff']));

-- 2) Per-staff permission grants.
CREATE TABLE IF NOT EXISTS staff_permissions (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission  TEXT NOT NULL,
    granted_by  UUID REFERENCES users(id),
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, permission)
);

CREATE INDEX IF NOT EXISTS idx_staff_permissions_user ON staff_permissions (user_id);
