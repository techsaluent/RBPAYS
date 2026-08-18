-- =====================================================================
-- Transaction MPIN: when enabled, every customer money transaction must be
-- confirmed with the member's login MPIN. Default off so existing flows are
-- unaffected until the super admin turns it on.
-- =====================================================================
INSERT INTO site_settings (key, value) VALUES ('security_require_txn_mpin', 'false')
ON CONFLICT (key) DO NOTHING;
