-- Visibility toggles for the two new legal pages (Data Policy, Account & Data
-- Deletion), matching the vis_page_* convention from migration 050. Default
-- 'true' = visible; ON CONFLICT DO NOTHING preserves any admin choice.

INSERT INTO site_settings (key, value) VALUES
  ('vis_page_data_policy',   'true'),
  ('vis_page_delete_account','true')
ON CONFLICT (key) DO NOTHING;
