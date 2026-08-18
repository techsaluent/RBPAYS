-- =====================================================================
-- Account security: login MPIN (PIN as 2nd factor instead of OTP),
-- self-service password change, and forgot/reset password.
-- =====================================================================

-- 4-6 digit MPIN (bcrypt-hashed), used as a second factor at login when set.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mpin_hash TEXT;

-- Password reset codes (hashed, short-lived, single-use).
CREATE TABLE IF NOT EXISTS password_resets (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id, created_at DESC);

-- Whether the panel should require members to set an MPIN.
INSERT INTO site_settings (key, value) VALUES ('security_require_mpin', 'false')
ON CONFLICT (key) DO NOTHING;
