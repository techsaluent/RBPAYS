-- =====================================================================
-- The super-admin account represents the operating company, so its display
-- name should be the company, not a generic "TutiPays Admin". Idempotent:
-- only touches the seeded placeholder name.
-- =====================================================================
UPDATE users
   SET full_name = 'REAL BROTHERS TECHNOLOGY SERVICES LLP'
 WHERE role = 'admin'
   AND full_name IN ('TutiPays Admin', 'RBPAYS Admin');
