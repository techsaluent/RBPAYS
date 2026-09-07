-- Marketing service catalog for the public home page.
--
-- The landing page's "All your services in one place" grid was hard-coded in
-- HTML. This table makes it fully admin-managed: the super admin can add,
-- edit, reorder, show/hide or delete the service cards shown on the site, and
-- the home page renders from GET /api/v1/site/services (with the static HTML
-- kept only as a no-JS / crawler fallback).
--
-- This is the MARKETING representation of a service (icon, title, blurb,
-- category, order, visibility) — deliberately separate from the operational
-- `services` table that drives transactions/commission. `code` optionally
-- links a card to that catalog for reference; it is not required.

CREATE TABLE IF NOT EXISTS site_services (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT,                                   -- optional link to services.code
  icon        TEXT NOT NULL DEFAULT '💠',             -- emoji, or an image URL
  title       TEXT NOT NULL,
  subtitle    TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT 'more',           -- bank | bill | pay | more
  sort_order  INTEGER NOT NULL DEFAULT 0,
  visible     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_services_order ON site_services (sort_order, id);

-- Seed the current home-page cards (only when the table is empty, so a
-- re-run never duplicates or overwrites an admin's edits).
INSERT INTO site_services (icon, title, subtitle, category, sort_order, code)
SELECT * FROM (VALUES
  ('📱', 'Mobile & DTH Recharge',   'Prepaid, postpaid and DTH for every operator.',        'bill',  1,  'recharge'),
  ('🏧', 'AEPS',                    'Aadhaar cash withdrawal, balance & mini statement.',   'bank',  2,  'aeps'),
  ('💸', 'Money Transfer (DMT)',    'IMPS/NEFT transfers to any bank account.',             'bank',  3,  'dmt'),
  ('🧾', 'BBPS Bill Payments',      'Electricity, gas, water, FASTag, loan & more.',        'bill',  4,  'bbps'),
  ('🏧', 'Micro ATM',               'Card-based cash withdrawal on a mini POS.',            'bank',  5,  'matm'),
  ('🆔', 'Aadhaar Pay',             'Accept payments with Aadhaar + fingerprint.',          'bank',  6,  'aadhaar_pay'),
  ('🏦', 'Payout & UPI',            'Instant disbursals to bank accounts and UPI IDs.',     'pay',   7,  'payout'),
  ('💳', 'Card Swipe (mPOS)',       'Accept debit/credit cards, settle to your wallet.',    'bank',  8,  'card_swipe'),
  ('💵', 'CMS',                     'Cash collection for NBFCs and lenders.',               'bank',  9,  'cms'),
  ('🪪', 'PAN Card',                'New & correction applications via NSDL/UTI.',          'more',  10, 'pan_card'),
  ('✈️', 'Travel Booking',          'Flight, bus, train & hotel bookings.',                 'more',  11, 'travel'),
  ('🛡️', 'Insurance',               'Motor, health, life & travel cover.',                  'more',  12, 'insurance'),
  ('🏦', 'Loan Repayment',          'Collect EMI / loan repayments for NBFCs & banks.',     'bill',  13, 'loan'),
  ('💳', 'Credit Card Bill',        'Pay any bank''s credit-card bill from your shop.',     'bill',  14, 'credit_card')
) AS seed(icon, title, subtitle, category, sort_order, code)
WHERE NOT EXISTS (SELECT 1 FROM site_services);
