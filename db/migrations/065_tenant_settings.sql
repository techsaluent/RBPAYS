-- White-label Stage 4: tenant isolation + per-tenant policy settings.
--
-- Operational data (members, transactions, wallets) is already isolated by the
-- parent_id hierarchy: a non-admin owner only ever sees their own network. This
-- stage adds (a) super-admin per-tenant visibility — a tenant overview and a
-- tenant_id filter on admin listings — and (b) per-tenant policy overrides:
-- KYC requirement, API rate limit, inbound webhook secret, settlement cycle.
--
-- tenant_settings is a simple key/value override store, read by the runtime
-- where a per-tenant policy should win over the platform default.

CREATE TABLE IF NOT EXISTS tenant_settings (
    tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, key)
);
