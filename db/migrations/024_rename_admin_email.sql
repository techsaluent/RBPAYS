-- =====================================================================
-- Rebrand the seeded super-admin email from the old RBPAYS domain to the
-- TutiPays domain. Idempotent: only touches the legacy address, and won't
-- collide if the TutiPays admin already exists.
-- =====================================================================
UPDATE users
   SET email = 'admin@tutipays.com'
 WHERE role = 'admin'
   AND lower(email) = 'admin@rbpays.in'
   AND NOT EXISTS (SELECT 1 FROM users u2 WHERE lower(u2.email) = 'admin@tutipays.com');
