-- 043_operator_circle_catalog.sql
-- Recharge operator + telecom circle catalog, and a richer biller directory.
-- Recharge operators were free text; this gives the panel a real dropdown and
-- lets the admin manage the list without a deploy.

-- ---- Recharge / DTH operators ---------------------------------------------
CREATE TABLE IF NOT EXISTS operators (
    code        TEXT PRIMARY KEY,                  -- short stable code, e.g. JIO, AIRTEL_DTH
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('prepaid','postpaid','dth')),
    enabled     BOOLEAN NOT NULL DEFAULT true,
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS operators_type_idx ON operators (type, enabled);

INSERT INTO operators (code, name, type, sort_order) VALUES
    ('JIO',        'Jio',                      'prepaid', 1),
    ('AIRTEL',     'Airtel',                   'prepaid', 2),
    ('VI',         'Vi (Vodafone Idea)',       'prepaid', 3),
    ('BSNL',       'BSNL',                     'prepaid', 4),
    ('JIO_POST',   'Jio Postpaid',             'postpaid', 1),
    ('AIRTEL_POST','Airtel Postpaid',          'postpaid', 2),
    ('VI_POST',    'Vi Postpaid',              'postpaid', 3),
    ('BSNL_POST',  'BSNL Postpaid',            'postpaid', 4),
    ('TATAPLAY',   'Tata Play',                'dth', 1),
    ('DISHTV',     'Dish TV',                  'dth', 2),
    ('AIRTEL_DTH', 'Airtel Digital TV',        'dth', 3),
    ('D2H',        'd2h (Videocon)',           'dth', 4),
    ('SUNDIRECT',  'Sun Direct',               'dth', 5)
ON CONFLICT (code) DO NOTHING;

-- ---- Telecom circles (for prepaid/postpaid) --------------------------------
CREATE TABLE IF NOT EXISTS telecom_circles (
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO telecom_circles (code, name) VALUES
    ('AP','Andhra Pradesh & Telangana'), ('AS','Assam'), ('BR','Bihar & Jharkhand'),
    ('CH','Chennai'), ('DL','Delhi NCR'), ('GJ','Gujarat'), ('HP','Himachal Pradesh'),
    ('HR','Haryana'), ('JK','Jammu & Kashmir'), ('KA','Karnataka'), ('KL','Kerala'),
    ('KO','Kolkata'), ('MP','Madhya Pradesh & Chhattisgarh'), ('MH','Maharashtra & Goa'),
    ('MU','Mumbai'), ('NE','North East'), ('OR','Odisha'), ('PB','Punjab'),
    ('RJ','Rajasthan'), ('TN','Tamil Nadu'), ('UE','UP East'), ('UW','UP West'),
    ('WB','West Bengal')
ON CONFLICT (code) DO NOTHING;

-- ---- Expand the biller directory ------------------------------------------
INSERT INTO billers (biller_id, name, category, coverage) VALUES
    ('ELEC-TATA-MUM',   'Tata Power Mumbai',        'electricity', 'state'),
    ('ELEC-ADANI-MUM',  'Adani Electricity Mumbai', 'electricity', 'state'),
    ('ELEC-TSSPDCL',    'TSSPDCL Telangana',        'electricity', 'state'),
    ('ELEC-APEPDCL',    'APEPDCL Andhra',           'electricity', 'state'),
    ('ELEC-PSPCL',      'PSPCL Punjab',             'electricity', 'state'),
    ('ELEC-UPPCL',      'UPPCL Uttar Pradesh',      'electricity', 'state'),
    ('GAS-MGL',         'Mahanagar Gas',            'gas',         'state'),
    ('GAS-GGL',         'Gujarat Gas',              'gas',         'state'),
    ('LPG-HP',          'HP Gas',                   'lpg',         'national'),
    ('LPG-BHARAT',      'Bharat Gas',               'lpg',         'national'),
    ('WATER-BWSSB',     'Bangalore Water (BWSSB)',  'water',       'state'),
    ('BROAD-JIOFIBER',  'JioFiber',                 'broadband',   'national'),
    ('BROAD-AIRTELXS',  'Airtel Xstream Fiber',     'broadband',   'national'),
    ('DTH-DISH',        'Dish TV',                  'dth',         'national'),
    ('DTH-AIRTEL',      'Airtel Digital TV',        'dth',         'national'),
    ('FASTAG-PAYTM',    'Paytm FASTag',             'fastag',      'national'),
    ('INS-HDFCLIFE',    'HDFC Life Insurance',      'insurance',   'national'),
    ('INS-SBILIFE',     'SBI Life Insurance',       'insurance',   'national'),
    ('MUN-MCGM',        'MCGM Mumbai Municipal',     'municipal',   'state'),
    ('CC-SBI',          'SBI Credit Card',          'credit_card', 'national'),
    ('CC-ICICI',        'ICICI Credit Card',        'credit_card', 'national'),
    ('LOAN-HDFC',       'HDFC Loan EMI',            'loan',        'national')
ON CONFLICT (biller_id) DO NOTHING;
