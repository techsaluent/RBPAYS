-- Front-end visibility toggles.
--
-- The public marketing site (home page sections, service cards, and the
-- standalone legal/company pages) can be shown or hidden by the admin without
-- any code change or redeploy. Each toggle is a site_settings row named
-- `vis_<kind>_<id>`:
--   vis_svc_<code>   -> a service card in the home-page "services" grid
--   vis_sec_<name>   -> a whole section of the home page
--   vis_page_<slug>  -> a standalone page (footer link + the page itself)
--
-- Convention: value 'true' = visible (default), 'false' = hidden. The marketing
-- pages fail OPEN — if the config endpoint is unreachable, nothing is hidden —
-- because this is a cosmetic/marketing control. The real regulatory switch that
-- stops a service being transacted is the per-service enable/disable on the
-- Services desk plus the KYC gate on the transaction path; this toggle only
-- governs what the public site advertises.
--
-- Seeded ON CONFLICT DO NOTHING so re-running never clobbers an admin's choice.

INSERT INTO site_settings (key, value) VALUES
  -- Service cards (match the home-page services grid)
  ('vis_svc_recharge',     'true'),
  ('vis_svc_aeps',         'true'),
  ('vis_svc_dmt',          'true'),
  ('vis_svc_bbps',         'true'),
  ('vis_svc_matm',         'true'),
  ('vis_svc_aadhaar_pay',  'true'),
  ('vis_svc_payout',       'true'),
  ('vis_svc_card_swipe',   'true'),
  ('vis_svc_cms',          'true'),
  ('vis_svc_pan',          'true'),
  ('vis_svc_travel',       'true'),
  ('vis_svc_insurance',    'true'),
  ('vis_svc_loan',         'true'),
  ('vis_svc_credit_card',  'true'),
  -- Home-page sections
  ('vis_sec_stats',        'true'),
  ('vis_sec_services',     'true'),
  ('vis_sec_why',          'true'),
  ('vis_sec_tiers',        'true'),
  ('vis_sec_how',          'true'),
  ('vis_sec_testimonials', 'true'),
  ('vis_sec_cta',          'true'),
  -- Standalone pages (footer link + the page's own body guard)
  ('vis_page_about',       'true'),
  ('vis_page_contact',     'true'),
  ('vis_page_grievance',   'true'),
  ('vis_page_faq',         'true'),
  ('vis_page_developers',  'true'),
  ('vis_page_terms',       'true'),
  ('vis_page_privacy',     'true'),
  ('vis_page_refund',      'true')
ON CONFLICT (key) DO NOTHING;
