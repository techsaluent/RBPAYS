import { query } from '../../../db';
import { ApiError } from '../../utils/ApiError';
import { makeReference } from '../../utils/reference';
import { getTenant, getTenantSetting } from './tenant.service';

/**
 * White-label Stage 5 — partner billing.
 *
 * A tenant's statement for a period: the net platform margin booked on its
 * network's transactions, split by partner_share_bps into the partner's
 * earning and the platform fee. Compute as a draft → issue (assigns a
 * statement reference) → mark paid when the partner's earning is settled out.
 */

/** Net platform_margin (credit − debit) booked on a tenant's txns within [start, end]. */
async function marginForPeriod(tenantId: string, start: string, end: string) {
  const { rows } = await query<{ net: string | null; n: string }>(
    `SELECT
        COALESCE(SUM(CASE WHEN jl.direction='credit' THEN jl.amount_paise ELSE -jl.amount_paise END),0) AS net,
        COUNT(DISTINCT t.id) AS n
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN transactions t ON t.reference = je.reference
       JOIN users u ON u.id = t.user_id
      WHERE jl.account_code = 'platform_margin'
        AND u.tenant_id = $1
        AND je.created_at >= $2::date
        AND je.created_at < ($3::date + INTERVAL '1 day')`,
    [tenantId, start, end],
  );
  return { grossMargin: Number(rows[0]?.net ?? 0), txnCount: Number(rows[0]?.n ?? 0) };
}

/**
 * A reseller's earnings for a period (multi-level white-label). For each DIRECT
 * sub-tenant: platform margin M on the sub-tenant's network → the sub-partner
 * keeps M × their partner_share_bps; the reseller earns (M − sub-partner cut) ×
 * the reseller's reseller_share_bps. Never negative. Returns the total plus a
 * per-sub-tenant breakdown.
 */
export async function resellerEarningsForPeriod(resellerTenantId: string, start: string, end: string) {
  await getTenant(resellerTenantId);
  if (new Date(start) > new Date(end)) throw ApiError.badRequest('Period start must be on or before period end');
  const resellerBps = Math.max(0, Math.min(10000, parseInt(await getTenantSetting(resellerTenantId, 'reseller_share_bps', '0'), 10) || 0));

  const { rows: subs } = await query<{ id: string; brand_name: string }>(
    'SELECT id, brand_name FROM tenants WHERE parent_tenant_id = $1 AND status = $2',
    [resellerTenantId, 'active'],
  );

  const breakdown: Array<{ tenant_id: string; brand_name: string; gross_margin_paise: number; sub_partner_cut_paise: number; reseller_earning_paise: number }> = [];
  let totalGross = 0;
  let totalEarning = 0;
  for (const s of subs) {
    const { grossMargin } = await marginForPeriod(s.id, start, end);
    const subBps = Math.max(0, Math.min(10000, parseInt(await getTenantSetting(s.id, 'partner_share_bps', '0'), 10) || 0));
    const subCut = grossMargin > 0 ? Math.floor((grossMargin * subBps) / 10000) : 0;
    const remainder = grossMargin - subCut;
    const resellerEarning = remainder > 0 ? Math.floor((remainder * resellerBps) / 10000) : 0;
    breakdown.push({ tenant_id: s.id, brand_name: s.brand_name, gross_margin_paise: grossMargin, sub_partner_cut_paise: subCut, reseller_earning_paise: resellerEarning });
    totalGross += grossMargin;
    totalEarning += resellerEarning;
  }
  return { reseller_share_bps: resellerBps, total_gross_margin_paise: totalGross, total_reseller_earning_paise: totalEarning, sub_tenants: breakdown };
}

/**
 * Partner (tenant-owner) dashboard: headline KPIs for a white-label brand —
 * this-month GTV / txns / gross margin, the partner's accrued earning for the
 * month (margin × share, not yet invoiced), the balance owed on issued-unpaid
 * statements, member counts by role, and the sub-brand count.
 */
export async function partnerDashboard(tenantId: string) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  const shareBps = Math.max(0, Math.min(10000, parseInt(await getTenantSetting(tenantId, 'partner_share_bps', '0'), 10) || 0));
  const { grossMargin, txnCount } = await marginForPeriod(tenantId, monthStart, today);
  const accruedEarning = grossMargin > 0 ? Math.floor((grossMargin * shareBps) / 10000) : 0;

  // GTV (successful transaction value) this month for the tenant's network.
  const gtv = await query<{ gtv: string; n: string }>(
    `SELECT COALESCE(SUM(t.amount_paise),0) AS gtv, COUNT(*) AS n
       FROM transactions t JOIN users u ON u.id = t.user_id
      WHERE u.tenant_id = $1 AND t.status = 'success'
        AND t.created_at >= $2::date AND t.created_at < ($3::date + INTERVAL '1 day')`,
    [tenantId, monthStart, today],
  );

  // Member counts by role in the brand.
  const members = await query<{ role: string; n: string }>(
    `SELECT role, COUNT(*) AS n FROM users WHERE tenant_id = $1 GROUP BY role`,
    [tenantId],
  );
  const memberCounts: Record<string, number> = {};
  let totalMembers = 0;
  for (const m of members.rows) { memberCounts[m.role] = Number(m.n); totalMembers += Number(m.n); }

  // Sub-brands (resellers) under this tenant.
  const subs = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM tenants WHERE parent_tenant_id = $1', [tenantId],
  );

  // Balance owed to the partner: issued-but-unpaid statements.
  const owed = await query<{ owed: string; count: string }>(
    `SELECT COALESCE(SUM(net_payable_paise),0) AS owed, COUNT(*) AS count
       FROM tenant_invoices WHERE tenant_id = $1 AND status = 'issued'`,
    [tenantId],
  );

  return {
    period: { month_start: monthStart, as_of: today },
    partner_share_bps: shareBps,
    month: {
      gtv_paise: Number(gtv.rows[0]?.gtv ?? 0),
      success_txns: Number(gtv.rows[0]?.n ?? 0),
      gross_margin_paise: grossMargin,
      margin_txns: txnCount,
      accrued_partner_earning_paise: accruedEarning,
    },
    members: { total: totalMembers, by_role: memberCounts },
    sub_brands: Number(subs.rows[0]?.n ?? 0),
    owed: { statements: Number(owed.rows[0]?.count ?? 0), net_payable_paise: Number(owed.rows[0]?.owed ?? 0) },
  };
}

/** Generate a reseller-earnings statement (kind='reseller') for a period. */
export async function generateResellerInvoice(resellerTenantId: string, start: string, end: string, notes?: string) {
  const e = await resellerEarningsForPeriod(resellerTenantId, start, end);
  const { rows } = await query(
    `INSERT INTO tenant_invoices
       (tenant_id, period_start, period_end, gross_margin_paise, partner_share_bps,
        partner_earning_paise, platform_fee_paise, net_payable_paise, txn_count, kind, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reseller',$10) RETURNING *`,
    [resellerTenantId, start, end, e.total_gross_margin_paise, e.reseller_share_bps,
      e.total_reseller_earning_paise, e.total_gross_margin_paise - e.total_reseller_earning_paise,
      e.total_reseller_earning_paise, e.sub_tenants.length,
      notes ?? `Reseller earnings across ${e.sub_tenants.length} sub-brand(s)`],
  );
  return { invoice: rows[0], breakdown: e };
}

export async function listInvoices(tenantId: string) {
  const { rows } = await query('SELECT * FROM tenant_invoices WHERE tenant_id = $1 ORDER BY period_start DESC, created_at DESC', [tenantId]);
  return rows;
}

export async function getInvoice(id: string) {
  const { rows } = await query('SELECT * FROM tenant_invoices WHERE id = $1', [id]);
  if (!rows[0]) throw ApiError.notFound('Invoice not found');
  return rows[0];
}

/**
 * Generate (or preview) a statement for a period. Snapshots the partner share
 * from the tenant's settings. Creates a draft row; the split is derived, never
 * trusted from the client.
 */
export async function generateInvoice(tenantId: string, start: string, end: string, notes?: string) {
  await getTenant(tenantId);
  if (new Date(start) > new Date(end)) throw ApiError.badRequest('Period start must be on or before period end');

  const shareBps = Math.max(0, Math.min(10000, parseInt(await getTenantSetting(tenantId, 'partner_share_bps', '0'), 10) || 0));
  const { grossMargin, txnCount } = await marginForPeriod(tenantId, start, end);
  // Margin can be negative (net reversals); never pay out a negative earning.
  const partnerEarning = grossMargin > 0 ? Math.floor((grossMargin * shareBps) / 10000) : 0;
  const platformFee = grossMargin - partnerEarning;

  const { rows } = await query(
    `INSERT INTO tenant_invoices
       (tenant_id, period_start, period_end, gross_margin_paise, partner_share_bps,
        partner_earning_paise, platform_fee_paise, net_payable_paise, txn_count, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [tenantId, start, end, grossMargin, shareBps, partnerEarning, platformFee, partnerEarning, txnCount, notes ?? null],
  );
  return rows[0];
}

/** Issue a draft statement: assign a statement reference and stamp issued_at. */
export async function issueInvoice(id: string) {
  const inv = await getInvoice(id);
  if (inv.status !== 'draft') throw ApiError.badRequest(`Only a draft can be issued (status: ${inv.status})`);
  const { rows } = await query(
    `UPDATE tenant_invoices SET status='issued', reference=$2, issued_at=now()
      WHERE id=$1 AND status='draft' RETURNING *`,
    [id, makeReference()],
  );
  if (!rows[0]) throw ApiError.conflict('Invoice is no longer a draft');
  return rows[0];
}

/** Mark an issued statement paid (partner earning settled out). */
export async function markInvoicePaid(id: string, settlementRef: string) {
  const inv = await getInvoice(id);
  if (inv.status !== 'issued') throw ApiError.badRequest(`Only an issued statement can be marked paid (status: ${inv.status})`);
  const { rows } = await query(
    `UPDATE tenant_invoices SET status='paid', settlement_ref=$2, paid_at=now()
      WHERE id=$1 AND status='issued' RETURNING *`,
    [id, settlementRef || null],
  );
  if (!rows[0]) throw ApiError.conflict('Invoice is no longer issued');
  return rows[0];
}

/** Void a draft or issued statement (not a paid one). */
export async function voidInvoice(id: string) {
  const inv = await getInvoice(id);
  if (inv.status === 'paid') throw ApiError.badRequest('A paid statement cannot be voided');
  const { rows } = await query(
    `UPDATE tenant_invoices SET status='void' WHERE id=$1 AND status IN ('draft','issued') RETURNING *`,
    [id],
  );
  if (!rows[0]) throw ApiError.conflict('Invoice cannot be voided');
  return rows[0];
}
