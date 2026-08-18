-- =====================================================================
-- Super-admin editable tax rates + caps.
--   Each row: a rate (basis points) and an optional maximum tax amount
--   (paise) per transaction. 0 = no cap. The tax engine reads these
--   instead of the hard-coded defaults, so rates can be changed live.
-- =====================================================================
CREATE TABLE IF NOT EXISTS tax_config (
    code             TEXT PRIMARY KEY,   -- tds_194h_std | tds_194h_high | tds_194n | gst
    label            TEXT NOT NULL,
    rate_bps         INT NOT NULL DEFAULT 0,        -- e.g. 500 = 5%
    max_amount_paise BIGINT NOT NULL DEFAULT 0,     -- cap on the tax amount (0 = none)
    enabled          BOOLEAN NOT NULL DEFAULT true,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tax_config (code, label, rate_bps, max_amount_paise) VALUES
    ('tds_194h_std',  'TDS 194H — commission (valid PAN filer)', 500,  0),
    ('tds_194h_high', 'TDS 194H — commission (no/invalid PAN, 206AB)', 2000, 0),
    ('tds_194n',      'TDS 194N — cash withdrawal beyond threshold', 200, 0),
    ('gst',           'GST on platform margin', 1800, 0)
ON CONFLICT (code) DO NOTHING;

DROP TRIGGER IF EXISTS trg_tax_config_updated ON tax_config;
CREATE TRIGGER trg_tax_config_updated BEFORE UPDATE ON tax_config
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
