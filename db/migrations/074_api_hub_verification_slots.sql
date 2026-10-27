-- API Hub: extra verification slots, including free public APIs.
--
-- These sit in platform_integrations (the API Hub) alongside the messaging /
-- OTP / KYC slots. Transaction rails (recharge, BBPS, DMT, AePS, travel/ticket
-- booking, insurance, etc.) are NOT here — they are configured per service
-- under Provider Connections (service_providers). These rows are value-added
-- lookup/verification APIs that other modules read by key.

INSERT INTO platform_integrations (key, label, category) VALUES
    ('ifsc_lookup', 'IFSC / Bank Branch Lookup',  'verification'),
    ('pincode',     'PIN Code / Postal Lookup',   'verification'),
    ('upi_verify',  'UPI VPA Verify',             'verification'),
    ('gst_verify',  'GST Number Verification',    'verification')
ON CONFLICT (key) DO NOTHING;

-- Razorpay's IFSC API and the India Post PIN-code API are free and keyless, so
-- these two can ship active out of the box (safe: read-only public lookups).
UPDATE platform_integrations
   SET provider = 'Razorpay IFSC (free)', base_url = 'https://ifsc.razorpay.com', is_active = true
 WHERE key = 'ifsc_lookup' AND (api_key IS NULL OR api_key = '') AND base_url IS NULL;

UPDATE platform_integrations
   SET provider = 'India Post (free)', base_url = 'https://api.postalpincode.in', is_active = true
 WHERE key = 'pincode' AND (api_key IS NULL OR api_key = '') AND base_url IS NULL;
