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
