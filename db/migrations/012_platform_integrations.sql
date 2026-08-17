-- =====================================================================
-- Platform integrations managed by the super admin.
--   Central place to hold API credentials for the non-transaction
--   services (SMS, email, OTP, WhatsApp, Aadhaar e-KYC, PAN NSDL,
--   penny-drop, cyber-crime screening, etc). Going live = paste keys +
--   mark active. Transaction-rail providers live in `service_providers`.
-- =====================================================================
CREATE TABLE IF NOT EXISTS platform_integrations (
    key         TEXT PRIMARY KEY,     -- sms | email | otp | whatsapp | aadhaar_kyc | pan_nsdl | penny_drop | ...
    label       TEXT NOT NULL,
    category    TEXT NOT NULL DEFAULT 'other',  -- messaging | identity | verification | other
    provider    TEXT,                 -- e.g. MSG91, SMTP, Protean, Signzy
    base_url    TEXT,
    api_key     TEXT,
    api_secret  TEXT,
    sender_id   TEXT,                 -- SMS sender / email from / VPA etc
    extra       JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active   BOOLEAN NOT NULL DEFAULT false,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO platform_integrations (key, label, category) VALUES
    ('sms',         'SMS Gateway',              'messaging'),
    ('email',       'Email (SMTP/API)',         'messaging'),
    ('otp',         'OTP Service',              'messaging'),
    ('whatsapp',    'WhatsApp Business',        'messaging'),
    ('aadhaar_kyc', 'Aadhaar e-KYC (UIDAI)',    'identity'),
    ('pan_nsdl',    'PAN Verification (NSDL/Protean)', 'identity'),
    ('penny_drop',  'Bank Penny-Drop / Name Match',    'verification'),
    ('cybercrime',  'Cyber-crime / Negative List (I4C)', 'verification'),
    ('vahan',       'Vahan Vehicle Lookup',     'verification')
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS trg_platform_integrations_updated ON platform_integrations;
CREATE TRIGGER trg_platform_integrations_updated BEFORE UPDATE ON platform_integrations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
