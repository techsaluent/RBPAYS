-- 044_provider_directory.sql
-- A directory of known Indian fintech API providers, shown as quick-pick
-- starting points when adding a provider. It carries NO credentials and NO
-- live endpoints — the admin pastes the real base URL + keys the provider
-- issues on onboarding, then Tests and Activates. Most are generic REST APIs,
-- so the suggested driver is `dynamic` (configured with no code via the AI
-- Integration Studio from the provider's own docs); AeronPay/Eko have built-in
-- drivers already.
CREATE TABLE IF NOT EXISTS provider_directory (
    key               TEXT PRIMARY KEY,          -- stable slug
    name              TEXT NOT NULL,
    website           TEXT,
    services          TEXT,                       -- human list of what it supports
    suggested_driver  TEXT NOT NULL DEFAULT 'dynamic',
    notes             TEXT,
    sort_order        INT NOT NULL DEFAULT 0,
    enabled           BOOLEAN NOT NULL DEFAULT true,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO provider_directory (key, name, website, services, suggested_driver, notes, sort_order) VALUES
    ('nxtbanking',  'NXTBanking',              'https://www.nxtbanking.com',   'DMT, AEPS, BBPS, recharge', 'dynamic', 'Full-stack fintech API. Base URL + keys issued on onboarding; build the config in AI Integration Studio from their docs, then Test.', 1),
    ('laraware',    'Laraware Private Limited','https://www.laraware.in',      'DMT (IMPS)',                'dynamic', 'High commission (~0.65%), IMPS-based DMT. Paste the issued base URL + keys, then Test.', 2),
    ('paysprint',   'PaySprint',               'https://paysprint.in',         'DMT, AEPS, BBPS, recharge', 'dynamic', 'Full-stack API (DMT/AEPS/BBPS). Uses JWT + partner auth headers — capture them in the dynamic config.', 3),
    ('pay2all',     'Pay2All',                 'https://www.pay2all.in',       'DMT (IMPS/NEFT)',           'dynamic', 'KYC-based DMT. Paste base URL + keys, then Test.', 4),
    ('fino',        'Fino Payments Bank',      'https://www.finobank.com',     'DMT, AEPS',                 'dynamic', 'Bank-backed DMT/AEPS; strong compliance. Endpoints + keys per your Fino agreement.', 5),
    ('oxigen',      'Oxigen Services',         'https://www.oxigen.co.in',     'DMT, recharge, BBPS',       'dynamic', 'Multi-service platform. Configure per their API docs.', 6),
    ('paynearby',   'PayNearby',               'https://www.paynearby.in',     'DMT, AEPS',                 'dynamic', 'Rural/semi-urban network with DMT + financial services. Endpoints + keys per your PayNearby agreement.', 7),
    ('spicemoney',  'Spice Money',             'https://www.spicemoney.com',   'AEPS, DMT',                 'dynamic', 'Rural fintech (AEPS + DMT). Configure per their API docs.', 8),
    ('roundpay',    'RoundPay',                'https://www.roundpay.net',     'DMT (IMPS/NEFT), payout',   'dynamic', 'Multi-bank DMT + payout. Paste base URL + keys, then Test.', 9),
    ('payrupees',   'PayRupees',               'https://www.payrupees.com',    'DMT, payout',               'dynamic', 'DMT + payout APIs. Configure per their docs, then Test.', 10)
ON CONFLICT (key) DO NOTHING;
