-- Multi-level white-label: a reseller (a tenant owner) can create sub-tenants
-- under their own network and earn a share of the platform margin on each
-- sub-tenant's activity, on top of the sub-partner's own share.
--
-- parent_tenant_id links a sub-tenant to the reseller tenant that created it.
-- tenant_invoices.kind distinguishes a reseller-earnings statement from a
-- partner's own statement. reseller_share_bps lives in tenant_settings (no
-- schema change) and defaults to 0, so nothing changes until a reseller sets it.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS parent_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tenants_parent_idx ON tenants (parent_tenant_id);

ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'partner'
  CHECK (kind IN ('partner', 'reseller'));
