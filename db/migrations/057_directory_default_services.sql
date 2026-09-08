-- Make every known provider a one-click preset for Provider Connections.
--
-- The provider_directory listed each provider's services as free text. This
-- adds structured default_services (service codes) + a base_url so that picking
-- a provider in the Provider Connections modal auto-selects the services it
-- powers and pre-fills its endpoint — the admin then only adds credentials.

ALTER TABLE provider_directory ADD COLUMN IF NOT EXISTS default_services TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE provider_directory ADD COLUMN IF NOT EXISTS base_url TEXT;

UPDATE provider_directory SET default_services = v.svc, base_url = COALESCE(v.base, base_url)
FROM (VALUES
  ('eko',        ARRAY['dmt','aeps','bbps','recharge'],       'https://api.eko.in/ekoicici/v3'),
  ('aeronpay',   ARRAY['payout','recharge','bbps','dmt'],      NULL),
  ('nxtbanking', ARRAY['dmt','aeps','bbps','recharge'],        NULL),
  ('laraware',   ARRAY['dmt'],                                 NULL),
  ('paysprint',  ARRAY['dmt','aeps','bbps','recharge'],        NULL),
  ('pay2all',    ARRAY['dmt'],                                 NULL),
  ('fino',       ARRAY['dmt','aeps'],                          NULL),
  ('oxigen',     ARRAY['dmt','recharge','bbps'],               NULL),
  ('paynearby',  ARRAY['dmt','aeps'],                          NULL),
  ('spicemoney', ARRAY['aeps','dmt'],                          NULL),
  ('roundpay',   ARRAY['dmt','payout'],                        NULL),
  ('payrupees',  ARRAY['dmt','payout'],                        NULL)
) AS v(key, svc, base)
WHERE provider_directory.key = v.key;
