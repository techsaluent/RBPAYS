-- =====================================================================
-- Allow the AeronPay and Eko provider drivers.
--   The driver CHECK constraint (migration 009) only permitted the original
--   four drivers. Widen it so admins can register AeronPay / Eko providers.
-- =====================================================================
ALTER TABLE service_providers DROP CONSTRAINT IF EXISTS service_providers_driver_check;
ALTER TABLE service_providers
    ADD CONSTRAINT service_providers_driver_check
    CHECK (driver IN ('sandbox','aggregator','razorpay','generic','aeronpay','eko'));
