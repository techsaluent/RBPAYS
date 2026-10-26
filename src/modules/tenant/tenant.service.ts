import { promises as dns } from 'dns';
import { randomBytes } from 'crypto';
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

interface TenantRow {
  id: string; brand_name: string; logo_url: string | null; logo_emoji: string | null;
  primary_color: string | null; tagline: string | null; support_email: string | null;
  support_phone: string | null; company_name: string | null; status: string;
}

/** Merge an active tenant's brand over the platform defaults (a field wins only when set). */
function mergeTenant(t: TenantRow, defaults: Branding): Branding {
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

/**
 * Resolve the branding for a member: their tenant's brand merged over the
 * platform defaults (a tenant field overrides the default only when set). A
 * member with no (or a suspended) tenant gets the platform brand.
 */
export async function resolveBranding(userId: string): Promise<Branding> {
  const defaults = await platformDefaults();
  const { rows } = await query<TenantRow>(
    `SELECT t.* FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = $1 AND t.status = 'active'`,
    [userId],
  );
  return rows[0] ? mergeTenant(rows[0], defaults) : defaults;
}

// ---- Host → tenant resolution (Stage 2: custom domains) ----------------

/** Normalise a Host header to a bare lowercase hostname (no scheme, port or trailing dot). */
export function normalizeHost(host: string | undefined | null): string {
  if (!host) return '';
  let h = String(host).trim().toLowerCase();
  h = h.replace(/^https?:\/\//, '').replace(/\/.*$/, ''); // strip scheme + path
  h = h.replace(/:\d+$/, ''); // strip port
  h = h.replace(/\.$/, ''); // strip trailing dot
  return h;
}

/** The active tenant that owns a verified custom domain, or null. */
async function tenantByHost(host: string): Promise<TenantRow | null> {
  const h = normalizeHost(host);
  if (!h) return null;
  const { rows } = await query<TenantRow>(
    `SELECT t.* FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id
      WHERE d.domain = $1 AND d.verified_at IS NOT NULL AND t.status = 'active'
      LIMIT 1`,
    [h],
  );
  return rows[0] ?? null;
}

/**
 * Resolve branding for a public request by its Host header — used by the
 * login / landing page to theme a custom domain before anyone signs in.
 * Falls back to the platform brand for an unknown or unverified host.
 */
export async function brandingForHost(host: string | undefined | null): Promise<Branding> {
  const defaults = await platformDefaults();
  const t = host ? await tenantByHost(host) : null;
  return t ? mergeTenant(t, defaults) : defaults;
}

// ---- Domain management (admin) -----------------------------------------

const DNS_VERIFY_PREFIX = '_tutipays-verify';

export async function listDomains(tenantId: string) {
  const { rows } = await query('SELECT * FROM tenant_domains WHERE tenant_id = $1 ORDER BY created_at', [tenantId]);
  return rows;
}

/** Register a domain for a tenant and mint its DNS-TXT verification token. */
export async function addDomain(tenantId: string, domainRaw: string) {
  const domain = normalizeHost(domainRaw);
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw ApiError.badRequest('Enter a valid domain, e.g. pay.brand.com');
  await getTenant(tenantId); // 404 if the tenant does not exist
  const token = 'tp-verify-' + randomBytes(16).toString('hex');
  try {
    const { rows } = await query<Record<string, unknown> & { domain: string }>(
      `INSERT INTO tenant_domains (tenant_id, domain, verify_token) VALUES ($1,$2,$3) RETURNING *`,
      [tenantId, domain, token],
    );
    return { ...rows[0], dns_record: { host: `${DNS_VERIFY_PREFIX}.${domain}`, type: 'TXT', value: token } };
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw ApiError.conflict('That domain is already registered');
    throw e;
  }
}

/**
 * Check the DNS TXT record for a pending domain. On success marks it verified
 * (ssl_status stays 'pending' until ops provision the certificate). Returns the
 * records seen so the admin can debug a mismatch.
 */
export async function verifyDomain(tenantId: string, domainId: string) {
  const { rows } = await query<{ domain: string; verify_token: string; verified_at: string | null }>(
    'SELECT domain, verify_token, verified_at FROM tenant_domains WHERE id = $1 AND tenant_id = $2',
    [domainId, tenantId],
  );
  const d = rows[0];
  if (!d) throw ApiError.notFound('Domain not found');
  if (d.verified_at) return { verified: true, already: true };

  let found: string[] = [];
  try {
    const records = await dns.resolveTxt(`${DNS_VERIFY_PREFIX}.${d.domain}`);
    found = records.map((parts) => parts.join(''));
  } catch (e) {
    return { verified: false, error: `No TXT record found (${(e as Error).message})`, expected: d.verify_token };
  }
  if (!found.includes(d.verify_token)) {
    return { verified: false, error: 'TXT record found but value does not match', expected: d.verify_token, found };
  }
  await query('UPDATE tenant_domains SET verified_at = now() WHERE id = $1', [domainId]);
  return { verified: true };
}

/** Patch a domain's primary flag or ssl_status (ops/CDN callback). Enforces one primary per tenant. */
export async function updateDomain(
  tenantId: string,
  domainId: string,
  patch: { is_primary?: boolean; ssl_status?: 'pending' | 'active' | 'error' },
) {
  if (patch.is_primary) {
    await query('UPDATE tenant_domains SET is_primary = false WHERE tenant_id = $1', [tenantId]);
  }
  const { rows } = await query(
    `UPDATE tenant_domains SET
        is_primary = COALESCE($3, is_primary),
        ssl_status = COALESCE($4, ssl_status)
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [domainId, tenantId, patch.is_primary ?? null, patch.ssl_status ?? null],
  );
  if (!rows[0]) throw ApiError.notFound('Domain not found');
  return rows[0];
}

export async function deleteDomain(tenantId: string, domainId: string) {
  const { rowCount } = await query('DELETE FROM tenant_domains WHERE id = $1 AND tenant_id = $2', [domainId, tenantId]);
  if (!rowCount) throw ApiError.notFound('Domain not found');
}

// ---- Per-tenant service visibility (Stage 3) ---------------------------

/** The active tenant id that owns a verified host, or null. */
export async function tenantIdForHost(host: string | undefined | null): Promise<string | null> {
  const t = host ? await tenantByHost(host) : null;
  return t ? t.id : null;
}

/** Service codes a tenant has explicitly hidden (visible = false). */
export async function hiddenServiceCodes(tenantId: string): Promise<string[]> {
  const { rows } = await query<{ service_code: string }>(
    'SELECT service_code FROM tenant_service_visibility WHERE tenant_id = $1 AND visible = false',
    [tenantId],
  );
  return rows.map((r) => r.service_code);
}

/** Hidden service codes for a request host's tenant ([] when no tenant host). */
export async function hiddenServiceCodesForHost(host: string | undefined | null): Promise<string[]> {
  const id = await tenantIdForHost(host);
  return id ? hiddenServiceCodes(id) : [];
}

/**
 * The tenant's service-visibility matrix for the admin UI: every catalog
 * service with its current effective visibility for this tenant (an explicit
 * override wins; absent = visible).
 */
export async function tenantServiceMatrix(tenantId: string) {
  const { rows } = await query<{ code: string; name: string | null; enabled: boolean; visible: boolean | null }>(
    `SELECT s.code, s.name, s.enabled, v.visible
       FROM services s
       LEFT JOIN tenant_service_visibility v ON v.service_code = s.code AND v.tenant_id = $1
      ORDER BY s.code`,
    [tenantId],
  );
  return rows.map((r) => ({ code: r.code, name: r.name, enabled: r.enabled, visible: r.visible !== false }));
}

/** Upsert a tenant's visibility override for one service. */
export async function setTenantServiceVisibility(tenantId: string, serviceCode: string, visible: boolean) {
  await getTenant(tenantId);
  await query(
    `INSERT INTO tenant_service_visibility (tenant_id, service_code, visible) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, service_code) DO UPDATE SET visible = EXCLUDED.visible`,
    [tenantId, serviceCode, visible],
  );
}

// ---- Tenant overview + settings (Stage 4: isolation & tenant-admin) ----

/**
 * Super-admin visibility for one tenant: its whole network (recursive over
 * parent_id from the owner, plus any directly-tagged members), wallet balances,
 * transaction volume, and net platform margin booked on its members' txns.
 */
export async function tenantOverview(tenantId: string) {
  await getTenant(tenantId);

  const members = await query<{ role: string; n: string; active: string }>(
    `SELECT role, COUNT(*) AS n, COUNT(*) FILTER (WHERE status = 'active') AS active
       FROM users WHERE tenant_id = $1 GROUP BY role`,
    [tenantId],
  );
  const wallet = await query<{ total: string | null; held: string | null }>(
    `SELECT COALESCE(SUM(w.balance_paise),0) AS total
       FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.tenant_id = $1`,
    [tenantId],
  );
  const txns = await query<{ status: string; n: string; volume: string | null }>(
    `SELECT t.status::text AS status, COUNT(*) AS n, COALESCE(SUM(t.amount_paise),0) AS volume
       FROM transactions t JOIN users u ON u.id = t.user_id
      WHERE u.tenant_id = $1 GROUP BY t.status`,
    [tenantId],
  );
  const margin = await query<{ net: string | null }>(
    `SELECT COALESCE(SUM(CASE WHEN jl.direction='credit' THEN jl.amount_paise ELSE -jl.amount_paise END),0) AS net
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN transactions t ON t.reference = je.reference
       JOIN users u ON u.id = t.user_id
      WHERE jl.account_code = 'platform_margin' AND u.tenant_id = $1`,
    [tenantId],
  );

  const byRole: Record<string, { total: number; active: number }> = {};
  let memberTotal = 0;
  for (const r of members.rows) {
    byRole[r.role] = { total: Number(r.n), active: Number(r.active) };
    memberTotal += Number(r.n);
  }
  const txnByStatus: Record<string, { count: number; volume_paise: number }> = {};
  let txnCount = 0;
  let successVolume = 0;
  for (const r of txns.rows) {
    txnByStatus[r.status] = { count: Number(r.n), volume_paise: Number(r.volume ?? 0) };
    txnCount += Number(r.n);
    if (r.status === 'success') successVolume += Number(r.volume ?? 0);
  }
  return {
    members: { total: memberTotal, by_role: byRole },
    wallet_balance_paise: Number(wallet.rows[0]?.total ?? 0),
    transactions: { total: txnCount, success_volume_paise: successVolume, by_status: txnByStatus },
    platform_margin_paise: Number(margin.rows[0]?.net ?? 0),
  };
}

// Per-tenant policy overrides the runtime may honour over platform defaults.
const TENANT_SETTING_KEYS = new Set([
  'kyc_required',            // 'true' | 'false'
  'rate_limit_per_min',      // integer, partner API throttle
  'webhook_secret',          // inbound webhook HMAC secret for this tenant's keys
  'settlement_cycle',        // e.g. 'T+1', 'weekly'
  'min_wallet_balance_paise',// soft floor warning
  'partner_share_bps',       // revenue share of platform margin paid to the partner (basis points)
  'reseller_share_bps',      // a reseller's share of margin left on its sub-tenants (basis points)
  'notes',                   // free text for admins
]);

export async function getTenantSettings(tenantId: string): Promise<Record<string, string>> {
  const { rows } = await query<{ key: string; value: string | null }>(
    'SELECT key, value FROM tenant_settings WHERE tenant_id = $1',
    [tenantId],
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value ?? '';
  return out;
}

/** One effective setting for a tenant, or the supplied fallback. */
export async function getTenantSetting(tenantId: string, key: string, fallback = ''): Promise<string> {
  const { rows } = await query<{ value: string | null }>(
    'SELECT value FROM tenant_settings WHERE tenant_id = $1 AND key = $2',
    [tenantId, key],
  );
  return rows[0]?.value ?? fallback;
}

export async function setTenantSetting(tenantId: string, key: string, value: string) {
  if (!TENANT_SETTING_KEYS.has(key)) throw ApiError.badRequest(`Unknown tenant setting: ${key}`);
  await getTenant(tenantId);
  await query(
    `INSERT INTO tenant_settings (tenant_id, key, value) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [tenantId, key, value],
  );
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

/** The tenant a member owns (owner_user_id = them), or null. owner_user_id is UNIQUE. */
export async function getTenantByOwner(ownerUserId: string) {
  const { rows } = await query('SELECT * FROM tenants WHERE owner_user_id = $1', [ownerUserId]);
  return rows[0] ?? null;
}

/** True if the member owns a white-label brand (for the panel to show "My Brand"). */
export async function ownsTenant(ownerUserId: string): Promise<boolean> {
  const { rows } = await query('SELECT 1 FROM tenants WHERE owner_user_id = $1', [ownerUserId]);
  return rows.length > 0;
}

/**
 * The id of the tenant a member owns, or throw 403. Scopes every self-service
 * brand operation to the caller's own tenant — the tenant id is derived here,
 * never trusted from the client.
 */
export async function requireOwnedTenantId(ownerUserId: string): Promise<string> {
  const t = await getTenantByOwner(ownerUserId);
  if (!t) throw ApiError.forbidden('You do not manage a white-label brand');
  return t.id;
}

// ---- Multi-level white-label (reseller → sub-tenants) ------------------

/** Is candidateUserId somewhere in ancestorUserId's downline (parent_id tree)? Bounded. */
export async function isInDownline(ancestorUserId: string, candidateUserId: string): Promise<boolean> {
  const { rows } = await query<{ ok: boolean }>(
    `WITH RECURSIVE dn AS (
        SELECT id, 1 AS depth FROM users WHERE parent_id = $1
        UNION ALL
        SELECT u.id, dn.depth + 1 FROM users u JOIN dn ON u.parent_id = dn.id WHERE dn.depth < 25)
      SELECT true AS ok FROM dn WHERE id = $2 LIMIT 1`,
    [ancestorUserId, candidateUserId],
  );
  return rows.length > 0;
}

/** Direct sub-tenants of a reseller tenant, with owner + member counts. */
export async function listSubTenants(parentTenantId: string) {
  const { rows } = await query(
    `SELECT t.*, u.full_name AS owner_name, u.phone AS owner_phone,
            (SELECT count(*) FROM users m WHERE m.tenant_id = t.id) AS members
       FROM tenants t LEFT JOIN users u ON u.id = t.owner_user_id
      WHERE t.parent_tenant_id = $1 ORDER BY t.created_at DESC`,
    [parentTenantId],
  );
  return rows;
}

/**
 * A reseller (owner of resellerTenant) creates a sub-tenant. The sub-tenant's
 * owner MUST be within the reseller-owner's own downline, so a reseller can
 * only brand members of their own network. parent_tenant_id links it back.
 */
export async function createSubTenant(
  resellerOwnerId: string,
  resellerTenantId: string,
  input: TenantInput & { partner_share_bps?: number },
) {
  if (!input.owner_user_id) throw ApiError.badRequest('Pick a member from your network to own the sub-brand');
  if (input.owner_user_id === resellerOwnerId) throw ApiError.badRequest('The sub-brand owner must be a member below you, not yourself');
  if (!(await isInDownline(resellerOwnerId, input.owner_user_id))) {
    throw ApiError.forbidden('That member is not in your network');
  }
  const existing = await getTenantByOwner(input.owner_user_id);
  if (existing) throw ApiError.conflict('That member already owns a brand');

  const tenant = (await createTenant({ ...input })) as { id: string }; // tags owner + downline with the new tenant_id
  await query('UPDATE tenants SET parent_tenant_id = $2 WHERE id = $1', [tenant.id, resellerTenantId]);
  if (input.partner_share_bps != null) {
    await setTenantSetting(tenant.id, 'partner_share_bps', String(Math.max(0, Math.min(10000, Math.round(input.partner_share_bps)))));
  }
  return getTenant(tenant.id); // the full row, now with parent_tenant_id set
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
