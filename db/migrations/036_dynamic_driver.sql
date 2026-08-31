-- =====================================================================
-- Config-driven "dynamic" provider driver.
--   A dynamic provider is defined entirely by data in service_providers.extra
--   (endpoints, request/response field maps, auth, status rules) — so a new
--   aggregator can be added or changed without any code, self-tested, and
--   activated live. This just permits the new driver value.
-- =====================================================================
ALTER TABLE service_providers DROP CONSTRAINT IF EXISTS service_providers_driver_check;
ALTER TABLE service_providers
    ADD CONSTRAINT service_providers_driver_check
    CHECK (driver IN ('sandbox','aggregator','razorpay','generic','aeronpay','eko','dynamic'));
