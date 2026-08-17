-- =====================================================================
-- Role-specific KYC requirements, onboarding risk scoring, probation
-- tiers with daily caps, and device / geofence binding.
-- =====================================================================

-- ---------- Role-specific KYC requirements ---------------------------
-- What documents each role must submit. Retailers are individual-KYC;
-- distributors add business proof + GST; master distributors add company
-- (CIN / board resolution / directors) proof.
CREATE TABLE IF NOT EXISTS role_kyc_requirements (
    role       TEXT NOT NULL,
    doc_type   TEXT NOT NULL,
    label      TEXT NOT NULL,
    mandatory  BOOLEAN NOT NULL DEFAULT true,
    sort_order INT NOT NULL DEFAULT 0,
    PRIMARY KEY (role, doc_type)
);

INSERT INTO role_kyc_requirements (role, doc_type, label, mandatory, sort_order) VALUES
    -- Retailer (Banking Mitra) — individual identity
    ('retailer','pan','PAN card (individual)',true,1),
    ('retailer','aadhaar','Aadhaar e-KYC',true,2),
    ('retailer','bank_proof','Bank account (penny-drop / passbook)',true,3),
    ('retailer','shop_photo','Shop storefront photo',true,4),
    ('retailer','selfie','Owner selfie / photo',false,5),
    -- Distributor — proprietor + business proof
    ('distributor','pan','Owner PAN card',true,1),
    ('distributor','aadhaar','Owner Aadhaar e-KYC',true,2),
    ('distributor','gst','GSTIN certificate',true,3),
    ('distributor','bank_proof','Firm bank account (penny-drop)',true,4),
    ('distributor','shop_photo','Trade / Udyam / Shop & Establishment licence',true,5),
    -- Master Distributor — corporate entity
    ('master_distributor','pan','Company PAN',true,1),
    ('master_distributor','gst','Company GSTIN',true,2),
    ('master_distributor','incorporation','Certificate of Incorporation (CIN / MCA)',true,3),
    ('master_distributor','bank_proof','Company current account (penny-drop)',true,4),
    ('master_distributor','board_resolution','Board resolution authorising the tie-up',true,5),
    ('master_distributor','aadhaar','Authorised signatory / directors KYC',true,6)
ON CONFLICT (role, doc_type) DO NOTHING;

-- ---------- Onboarding risk assessment -------------------------------
CREATE TABLE IF NOT EXISTS onboarding_assessments (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    identity_score     INT NOT NULL DEFAULT 0,
    geo_score          INT NOT NULL DEFAULT 0,
    bank_score         INT NOT NULL DEFAULT 0,
    device_score       INT NOT NULL DEFAULT 0,
    distributor_score  INT NOT NULL DEFAULT 0,
    total_score        INT NOT NULL DEFAULT 0,   -- 0..100, lower = safer
    decision           TEXT NOT NULL,            -- auto_approve | video_kyc | reject
    detail             JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onboarding_user_idx ON onboarding_assessments (user_id, created_at DESC);

-- ---------- Probation tier + daily caps + geofence on users ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'probation'
    CHECK (tier IN ('probation','full'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS probation_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_cashout_cap_paise BIGINT;  -- NULL = tier default
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_dmt_cap_paise BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS shop_lat NUMERIC(9,6);
ALTER TABLE users ADD COLUMN IF NOT EXISTS shop_lng NUMERIC(9,6);
ALTER TABLE users ADD COLUMN IF NOT EXISTS geofence_radius_m INT;

-- ---------- Device binding -------------------------------------------
CREATE TABLE IF NOT EXISTS member_devices (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_uuid TEXT NOT NULL,
    label       TEXT,
    imei        TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    bound_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, device_uuid)
);
CREATE INDEX IF NOT EXISTS member_devices_user_idx ON member_devices (user_id);
