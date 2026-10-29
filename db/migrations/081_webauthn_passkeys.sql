-- Passkeys (WebAuthn / FIDO2): passwordless, phishing-resistant login.
--
-- A member registers one or more passkeys (device biometrics / security keys)
-- while signed in, then signs in with just the passkey — no password, no OTP.
-- Credentials are bound to the relying-party ID (the domain), so a passkey
-- registered on a white-label partner's domain is scoped to that domain.

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,            -- base64url credential id
  public_key    TEXT NOT NULL,                   -- base64url COSE public key
  counter       BIGINT NOT NULL DEFAULT 0,       -- signature counter (clone detection)
  transports    TEXT,                            -- comma-joined (usb, internal, hybrid, …)
  rp_id         TEXT NOT NULL,                   -- domain the passkey is bound to
  device_name   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_webauthn_cred_user ON webauthn_credentials (user_id);

-- Short-lived challenge issued at options time and consumed at verify time.
-- user_id is nullable: a login challenge is created even for an unknown
-- identifier so the response shape never reveals whether an account exists.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  challenge   TEXT NOT NULL,
  kind        TEXT NOT NULL,                     -- 'register' | 'login'
  rp_id       TEXT NOT NULL,
  origin      TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webauthn_chal_expiry ON webauthn_challenges (expires_at);
