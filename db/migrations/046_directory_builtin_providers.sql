-- 046_directory_builtin_providers.sql
-- Add the providers that already have a built-in driver (Eko, AeronPay) to the
-- provider directory so they show up in the "Known provider" quick-pick with
-- the correct driver pre-selected — no dynamic config needed for these two.
INSERT INTO provider_directory (key, name, website, services, suggested_driver, notes, sort_order) VALUES
    ('eko',      'Eko',      'https://eko.in',       'DMT, AEPS, BBPS, recharge', 'eko',      'Built-in driver. API key = developer_key, secret = access_key (signs each request), Partner ID = initiator_id; put user_code in Advanced config.', 0),
    ('aeronpay', 'AeronPay', 'https://aeronpay.in',  'Payout, recharge, BBPS, DMT', 'aeronpay', 'Built-in driver. Headers client-id / client-secret → API key = client-id, secret = client-secret.', 0)
ON CONFLICT (key) DO UPDATE
   SET name = EXCLUDED.name, website = EXCLUDED.website, services = EXCLUDED.services,
       suggested_driver = EXCLUDED.suggested_driver, notes = EXCLUDED.notes, sort_order = EXCLUDED.sort_order;
