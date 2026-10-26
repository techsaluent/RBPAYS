-- White-label Stage 2: custom domains per tenant.
--
-- A tenant (white-label partner) can serve the branded panel + marketing site
-- on their own hostname (e.g. shop.partnerbrand.com). Ownership of the domain
-- is proven with a DNS TXT record (_tutipays-verify.<domain> = verify_token).
-- TLS is provisioned by ops (Caddy/Nginx + ACME or a CDN); ssl_status tracks it.
--
-- The request host → tenant resolution reads this table (verified rows only) so
-- the login/landing page themes to the partner brand before any user signs in.

CREATE TABLE IF NOT EXISTS tenant_domains (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    domain       TEXT NOT NULL UNIQUE,                 -- lowercased host, no scheme/port
    verify_token TEXT NOT NULL,                        -- value expected in the DNS TXT record
    verified_at  TIMESTAMPTZ,                          -- NULL until DNS ownership is proven
    is_primary   BOOLEAN NOT NULL DEFAULT false,       -- the canonical host for this tenant
    ssl_status   TEXT NOT NULL DEFAULT 'pending' CHECK (ssl_status IN ('pending','active','error')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_domains_tenant_idx ON tenant_domains (tenant_id);
-- Only verified domains resolve to a tenant; index the common lookup.
CREATE INDEX IF NOT EXISTS tenant_domains_verified_idx ON tenant_domains (domain) WHERE verified_at IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    DROP TRIGGER IF EXISTS trg_tenant_domains_updated ON tenant_domains;
    CREATE TRIGGER trg_tenant_domains_updated BEFORE UPDATE ON tenant_domains
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
