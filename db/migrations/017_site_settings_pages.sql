-- =====================================================================
-- Website settings (branding) + custom pages, managed by the super admin.
--   Public endpoints expose these so the landing site and panel can render
--   the configured brand name, logo, colours, contact details and any
--   admin-authored pages without a code change.
-- =====================================================================
CREATE TABLE IF NOT EXISTS site_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO site_settings (key, value) VALUES
    ('brand_name',      'TutiPays'),
    ('logo_url',        ''),
    ('logo_emoji',      '₹'),
    ('tagline',         'One platform for every payment & recharge.'),
    ('primary_color',   '#7C3AED'),
    ('support_email',   'support@tutipays.com'),
    ('admin_email',     'admin@tutipays.com'),
    ('phone',           ''),
    ('company_name',    'REAL BROTHERS TECHNOLOGY SERVICES LLP'),
    ('company_address', 'Unnati Gupta, H7 Room No., Santosh Nagar, Goregaon East, Jogeshwari East, Aarey Milk Colony, Mumbai – 400065, Maharashtra, India'),
    ('company_pan',     'ABIFR6463M'),
    ('company_gst',     '27ABIFR6463M1ZH')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS site_pages (
    slug       TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL DEFAULT '',   -- HTML or plain text
    published  BOOLEAN NOT NULL DEFAULT true,
    sort_order INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_pages_pub_idx ON site_pages (published, sort_order);

DROP TRIGGER IF EXISTS trg_site_settings_updated ON site_settings;
CREATE TRIGGER trg_site_settings_updated BEFORE UPDATE ON site_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_site_pages_updated ON site_pages;
CREATE TRIGGER trg_site_pages_updated BEFORE UPDATE ON site_pages
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
