-- White-label Stage 3: per-tenant service visibility.
--
-- The branded marketing site + panel are theme-driven (no code fork per
-- partner). A tenant can also choose which services appear on *their* brand,
-- on top of the platform's own visibility. This table is an OVERRIDE: a row
-- with visible = false hides that service for the tenant; no row = inherit the
-- platform default (shown). The platform master switch (services.enabled) and
-- the global marketing visibility still apply first.

CREATE TABLE IF NOT EXISTS tenant_service_visibility (
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    service_code TEXT NOT NULL,
    visible      BOOLEAN NOT NULL DEFAULT true,
    PRIMARY KEY (tenant_id, service_code)
);

CREATE INDEX IF NOT EXISTS tenant_service_visibility_tenant_idx ON tenant_service_visibility (tenant_id);
