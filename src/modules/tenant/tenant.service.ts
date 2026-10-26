import { query } from '../../../db';
import { ApiError } from '../../utils/ApiError';

/** The resolved branding a panel / receipt / email should render. */
export interface Branding {
  tenant_id: string | null;
  brand_name: string;
  logo_url: string | null;
  logo_emoji: string | null;
  primary_color: string | null;
  tagline: string | null;
  support_email: string | null;
  support_phone: string | null;
  company_name: string | null;
}

/** Platform-wide brand defaults (site_settings) — the fallback for any tenant. */
async function platformDefaults(): Promise<Branding> {
  const keys = ['brand_name', 'logo_url', 'logo_emoji', 'primary_color', 'tagline', 'support_email', 'phone', 'company_name'];
  const { rows } = await query<{ key: string; value: string | null }>(
    'SELECT key, value FROM site_settings WHERE key = ANY($1)',
    [keys],
  );
  const m: Record<string, string | null> = {};
  for (const r of rows) m[r.key] = r.value;
  return {
    tenant_id: null,
    brand_name: m.brand_name || 'TutiPays',
    logo_url: m.logo_url || null,
    logo_emoji: m.logo_emoji || null,
    primary_color: m.primary_color || null,
    tagline: m.tagline || null,
    support_email: m.support_email || null,
    support_phone: m.phone || null,
    company_name: m.company_name || null,
  };
}

const pick = (a: string | null | undefined, b: string | null): string | null => (a && String(a).trim() ? a : b);

/**
 * Resolve the branding for a member: their tenant's brand merged over the
 * platform defaults (a tenant field overrides the default only when set). A
 * member with no (or a suspended) tenant gets the platform brand.
 */
export async function resolveBranding(userId: string): Promise<Branding> {
  const defaults = await platformDefaults();
  const { rows } = await query<{
    id: string; brand_name: string; logo_url: string | null; logo_emoji: string | null;
    primary_color: string | null; tagline: string | null; support_email: string | null;
    support_phone: string | null; company_name: string | null; status: string;
  }>(
    `SELECT t.* FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = $1 AND t.status = 'active'`,
    [userId],
  );
  const t = rows[0];
  if (!t) return defaults;
  return {
    tenant_id: t.id,
    brand_name: pick(t.brand_name, defaults.brand_name) || 'TutiPays',
    logo_url: pick(t.logo_url, defaults.logo_url),
    logo_emoji: pick(t.logo_emoji, defaults.logo_emoji),
    primary_color: pick(t.primary_color, defaults.primary_color),
    tagline: pick(t.tagline, defaults.tagline),
    support_email: pick(t.support_email, defaults.support_email),
    support_phone: pick(t.support_phone, defaults.support_phone),
    company_name: pick(t.company_name, defaults.company_name),
  };
}

// ---- Admin CRUD ---------------------------------------------------------

export interface TenantInput {
  brand_name: string;
  owner_user_id?: string | null;
  logo_url?: string | null;
  logo_emoji?: string | null;
  primary_color?: string | null;
  tagline?: string | null;
  support_email?: string | null;
  support_phone?: string | null;
  company_name?: string | null;
  status?: 'active' | 'suspended';
}

export async function listTenants() {
  const { rows } = await query(
    `SELECT t.*, u.full_name AS owner_name, u.phone AS owner_phone,
            (SELECT count(*) FROM users m WHERE m.tenant_id = t.id) AS members
       FROM tenants t LEFT JOIN users u ON u.id = t.owner_user_id
      ORDER BY t.created_at DESC`,
  );
  return rows;
}

export async function getTenant(id: string) {
  const { rows } = await query('SELECT * FROM tenants WHERE id = $1', [id]);
  if (!rows[0]) throw ApiError.notFound('Tenant not found');
  return rows[0];
}

/** Create a tenant and tag its owner (and the owner's existing downline) with it. */
export async function createTenant(input: TenantInput) {
  if (!input.brand_name?.trim()) throw ApiError.badRequest('Brand name is required');
  const { rows } = await query(
    `INSERT INTO tenants (owner_user_id, brand_name, logo_url, logo_emoji, primary_color, tagline, support_email, support_phone, company_name, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10,'active'))
     RETURNING *`,
    [
      input.owner_user_id ?? null, input.brand_name.trim(), input.logo_url ?? null, input.logo_emoji ?? null,
      input.primary_color ?? null, input.tagline ?? null, input.support_email ?? null, input.support_phone ?? null,
      input.company_name ?? null, input.status ?? null,
    ],
  );
  const tenant = rows[0];
  if (input.owner_user_id) await assignOwnerSubtree(input.owner_user_id, tenant.id);
  return tenant;
}

export async function updateTenant(id: string, patch: Partial<TenantInput>) {
  const { rows } = await query(
    `UPDATE tenants SET
        brand_name    = COALESCE($2, brand_name),
        owner_user_id = COALESCE($3, owner_user_id),
        logo_url      = COALESCE($4, logo_url),
        logo_emoji    = COALESCE($5, logo_emoji),
        primary_color = COALESCE($6, primary_color),
        tagline       = COALESCE($7, tagline),
        support_email = COALESCE($8, support_email),
        support_phone = COALESCE($9, support_phone),
        company_name  = COALESCE($10, company_name),
        status        = COALESCE($11, status)
      WHERE id = $1 RETURNING *`,
    [
      id, patch.brand_name ?? null, patch.owner_user_id ?? null, patch.logo_url ?? null, patch.logo_emoji ?? null,
      patch.primary_color ?? null, patch.tagline ?? null, patch.support_email ?? null, patch.support_phone ?? null,
      patch.company_name ?? null, patch.status ?? null,
    ],
  );
  if (!rows[0]) throw ApiError.notFound('Tenant not found');
  if (patch.owner_user_id) await assignOwnerSubtree(patch.owner_user_id, id);
  return rows[0];
}

/**
 * Tag the owner and everyone currently below them in the parent_id tree with
 * this tenant. Bounded recursive CTE; new downline inherits at creation time.
 */
async function assignOwnerSubtree(ownerId: string, tenantId: string): Promise<void> {
  await query(
    `WITH RECURSIVE subtree AS (
        SELECT id FROM users WHERE id = $1
        UNION ALL
        SELECT u.id FROM users u JOIN subtree s ON u.parent_id = s.id
     )
     UPDATE users SET tenant_id = $2 WHERE id IN (SELECT id FROM subtree)`,
    [ownerId, tenantId],
  );
}
