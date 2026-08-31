-- 041_security_2fa_sessions.sql
-- Security hardening: authenticator-app (TOTP) 2FA, login brute-force lockout,
-- and richer session metadata so members can see and revoke active sessions.

-- ---- Authenticator-app 2FA (RFC 6238 TOTP) --------------------------------
-- totp_secret holds the base32 shared secret. It is set at enrollment but 2FA
-- is only enforced once totp_enabled flips true (after the user proves they can
-- generate a valid code). This is separate from, and stacks with, the MPIN.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;

-- ---- Login brute-force lockout --------------------------------------------
-- Every login attempt (success or fail) is recorded. login() refuses further
-- attempts for an identifier once too many failures pile up inside a window.
CREATE TABLE IF NOT EXISTS login_attempts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identifier  TEXT NOT NULL,          -- lowercased email / phone / username as typed
    ip          TEXT,
    success     BOOLEAN NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_identifier_idx ON login_attempts (identifier, created_at DESC);
CREATE INDEX IF NOT EXISTS login_attempts_ip_idx ON login_attempts (ip, created_at DESC);

-- ---- Session metadata ------------------------------------------------------
-- Best-effort context captured when a refresh token is issued, so the member's
-- "active sessions" screen can show where each session came from.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_agent  TEXT;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS ip          TEXT;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
