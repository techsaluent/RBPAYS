-- =====================================================================
-- Signup OTP verification.
--   A prospect verifies ownership of their mobile (and/or email) before an
--   account is created. Codes are stored hashed, short-lived and single-use.
--   Delivery goes through the super-admin's active SMS / OTP integration
--   (platform_integrations); enable it with the security_require_signup_otp
--   site setting. Nothing here stores the raw code.
-- =====================================================================
CREATE TABLE IF NOT EXISTS signup_otps (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone       TEXT NOT NULL,
    email       TEXT,
    code_hash   TEXT NOT NULL,
    attempts    INT NOT NULL DEFAULT 0,
    used_at     TIMESTAMPTZ,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signup_otps_phone ON signup_otps (phone, created_at DESC);

-- Off by default so existing signup keeps working until an SMS/OTP provider
-- is configured. Super admin flips it on from Website -> Security policy.
INSERT INTO site_settings (key, value)
VALUES ('security_require_signup_otp', 'false')
ON CONFLICT (key) DO NOTHING;
