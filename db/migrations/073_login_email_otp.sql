-- Mandatory email OTP (two-factor) at login.
--
-- After the password (and any MPIN / authenticator) check passes, the member
-- must enter a one-time code emailed to their registered address before any
-- session token is issued. Controlled by the site setting
-- `security_require_login_otp` (default 'true' = mandatory for everyone).

CREATE TABLE IF NOT EXISTS login_otps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INT NOT NULL DEFAULT 0,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup of the most recent live code for a user.
CREATE INDEX IF NOT EXISTS idx_login_otps_user_live
  ON login_otps (user_id, created_at DESC)
  WHERE used_at IS NULL;

-- On by default: email OTP is mandatory at login until an admin turns it off.
INSERT INTO site_settings (key, value)
VALUES ('security_require_login_otp', 'true')
ON CONFLICT (key) DO NOTHING;
