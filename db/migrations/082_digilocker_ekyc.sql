-- DigiLocker e-KYC via API Setu (official government OAuth 2.0 + PKCE).
--
-- The member clicks "Verify with DigiLocker", authenticates on the official
-- government screen with their own Aadhaar/OTP, and consents. DigiLocker then
-- redirects back with a code we exchange for their verified identity — free,
-- no UIDAI licence. Credentials (client id/secret from the DigiLocker Partner
-- portal) are entered in API Hub under this integration key.
INSERT INTO platform_integrations (key, label, category, base_url) VALUES
  ('digilocker', 'DigiLocker e-KYC (API Setu)', 'identity', 'https://digilocker.meripehchaan.gov.in')
ON CONFLICT (key) DO NOTHING;

-- Short-lived pending-auth state for the OAuth + PKCE round trip (state is the
-- CSRF token; code_verifier is the PKCE secret). Consumed once at callback.
CREATE TABLE IF NOT EXISTS digilocker_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state         TEXT NOT NULL UNIQUE,
  code_verifier TEXT NOT NULL,
  redirect_uri  TEXT NOT NULL,
  return_url    TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_digilocker_sessions_expiry ON digilocker_sessions (expires_at);
