-- White-label Stage 1: tenants + per-member tenant assignment.
--
-- A "tenant" is a white-label partner's brand. The partner (an existing member,
-- usually a distributor/MD reseller) owns the tenant; their whole downline
-- inherits it via users.tenant_id. Branding (name/logo/colour/support) resolves
-- from the member's tenant, falling back to the platform defaults in
-- site_settings. tenant_id = NULL means the platform's own brand (TutiPays).
--
-- Later stages add custom domains, branded marketing sites, tenant isolation
-- and partner billing — all keyed off this tenant id.

CREATE TABLE IF NOT EXISTS tenants (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id  UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL,  -- the partner who owns this brand
    brand_name     TEXT NOT NULL,
    logo_url       TEXT,
    logo_emoji     TEXT,
    primary_color  TEXT,
    tagline        TEXT,
    support_email  TEXT,
    support_phone  TEXT,
    company_name   TEXT,
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS users_tenant_idx ON users (tenant_id);

-- Keep updated_at fresh (reuses the shared trigger function if present).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    DROP TRIGGER IF EXISTS trg_tenants_updated ON tenants;
    CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
