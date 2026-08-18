-- =====================================================================
-- Biometric-ready AEPS / Aadhaar Pay.
--   Stores only AUDIT metadata about the capture device and biometric
--   modality — never the raw biometrics or the encrypted PID block, which
--   are forwarded to the switch in-memory and never persisted.
-- =====================================================================
ALTER TABLE aeps_transactions ADD COLUMN IF NOT EXISTS biometric_type TEXT;   -- FMR | FIR | IIR
ALTER TABLE aeps_transactions ADD COLUMN IF NOT EXISTS device_serial TEXT;    -- RD device serial
ALTER TABLE aeps_transactions ADD COLUMN IF NOT EXISTS rd_service TEXT;       -- RD service / model info

ALTER TABLE aadhaar_pay_transactions ADD COLUMN IF NOT EXISTS biometric_type TEXT;
ALTER TABLE aadhaar_pay_transactions ADD COLUMN IF NOT EXISTS device_serial TEXT;
ALTER TABLE aadhaar_pay_transactions ADD COLUMN IF NOT EXISTS rd_service TEXT;
