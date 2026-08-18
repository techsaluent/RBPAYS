import { PoolClient } from 'pg';
import { query } from '../../../db';
import { env } from '../../config/env';

/**
 * Statutory tax helpers.
 *
 * TDS (Section 194H on commission): 5% for a member with a valid PAN who is a
 * regular filer; 20% when the PAN is missing/invalid or the member is a 206AB
 * non-filer. GST: 18% on the platform's retained margin, split CGST+SGST for
 * intra-state supply or IGST for inter-state (by place-of-supply state code).
 */
export const TDS_RATE_STD_BPS = 500; // 5%
export const TDS_RATE_HIGH_BPS = 2000; // 20%
export const GST_RATE_BPS = 1800; // 18%

export interface TaxProfile {
  pan_valid: boolean;
  is_206ab_non_filer: boolean;
  state_code: string | null;
}

/** Resolve a member's 194H TDS rate (basis points). Defaults to high if unknown. */
export async function tdsRateBpsFor(userId: string): Promise<number> {
  const { rows } = await query<TaxProfile>(
    'SELECT pan_valid, is_206ab_non_filer, state_code FROM tax_profiles WHERE user_id = $1',
    [userId],
  );
  const p = rows[0];
  if (p && p.pan_valid && !p.is_206ab_non_filer) return TDS_RATE_STD_BPS;
  return TDS_RATE_HIGH_BPS;
}

export function applyBps(amountPaise: number, bps: number): number {
  return Math.round((amountPaise * bps) / 10000);
}

/** Split a GST-inclusive amount into taxable base + tax at 18%. */
export function splitGstInclusive(inclusivePaise: number): { basePaise: number; gstPaise: number } {
  const basePaise = Math.round((inclusivePaise * 10000) / (10000 + GST_RATE_BPS));
  return { basePaise, gstPaise: inclusivePaise - basePaise };
}

/** Record a TDS deduction (Form 26Q source). */
export async function recordTds(
  client: PoolClient,
  p: {
    userId: string;
    serviceTxnId?: string;
    serviceCode?: string;
    section: '194H' | '194N';
    grossPaise: number;
    rateBps: number;
    tdsPaise: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO tds_records (user_id, service_txn_id, service_code, section, gross_paise, rate_bps, tds_paise, net_paise)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [p.userId, p.serviceTxnId ?? null, p.serviceCode ?? null, p.section, p.grossPaise, p.rateBps, p.tdsPaise, p.grossPaise - p.tdsPaise],
  );
}

/** Start of the current Indian financial year (1 April), as an ISO string. */
export function financialYearStart(): string {
  const now = new Date();
  const y = now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return `${y}-04-01T00:00:00.000Z`;
}

/**
 * Section 194N — TDS on cash withdrawals beyond the annual threshold.
 * Once a member's cumulative cash-out for the financial year crosses the
 * threshold (₹1 crore for a filer with a valid PAN, ₹20 lakh otherwise), 2%
 * TDS is withheld on the withdrawal. Returns the TDS withheld (paise) and
 * records it; 0 when under the threshold.
 */
export async function apply194N(
  client: PoolClient,
  p: { userId: string; serviceCode: string; amountPaise: number; serviceTxnId?: string; excludeTxnId?: string },
): Promise<number> {
  const prof = (
    await client.query<{ pan_valid: boolean }>('SELECT pan_valid FROM tax_profiles WHERE user_id = $1', [p.userId])
  ).rows[0];
  const filer = !!prof?.pan_valid;
  const threshold = filer ? env.TDS_194N_THRESHOLD_FILER_PAISE : env.TDS_194N_THRESHOLD_NONFILER_PAISE;

  // Sum this member's prior cash-out this FY, EXCLUDING the current txn (which
  // settleByReference has already marked success before this runs).
  const { rows } = await client.query<{ sum: string }>(
    `SELECT COALESCE(SUM(amount_paise),0)::text sum FROM transactions
      WHERE user_id = $1 AND service = ANY(ARRAY['aeps','matm'])
        AND status IN ('pending','success') AND created_at >= $2
        AND ($3::uuid IS NULL OR id <> $3)`,
    [p.userId, financialYearStart(), p.excludeTxnId ?? null],
  );
  const priorFy = Number(rows[0]?.sum ?? '0');
  // Only the portion of this withdrawal that pushes past the threshold is taxed.
  if (priorFy + p.amountPaise <= threshold) return 0;
  const taxableBase = Math.min(p.amountPaise, priorFy + p.amountPaise - threshold);
  const tds = applyBps(taxableBase, env.TDS_194N_RATE_BPS);
  if (tds <= 0) return 0;

  await recordTds(client, {
    userId: p.userId,
    serviceTxnId: p.serviceTxnId,
    serviceCode: p.serviceCode,
    section: '194N',
    grossPaise: taxableBase,
    rateBps: env.TDS_194N_RATE_BPS,
    tdsPaise: tds,
  });
  return tds;
}

/** Record a GST invoice on the platform margin, split intra/inter-state. */
export async function recordGst(
  client: PoolClient,
  p: {
    serviceTxnId?: string;
    serviceCode?: string;
    inclusivePaise: number;
    placeOfSupply?: string | null;
  },
): Promise<{ basePaise: number; gstPaise: number }> {
  const { basePaise, gstPaise } = splitGstInclusive(p.inclusivePaise);
  const intraState = !p.placeOfSupply || p.placeOfSupply === env.HOME_STATE_CODE;
  const cgst = intraState ? Math.round(gstPaise / 2) : 0;
  const sgst = intraState ? gstPaise - cgst : 0;
  const igst = intraState ? 0 : gstPaise;
  await client.query(
    `INSERT INTO gst_invoices (service_txn_id, service_code, taxable_base_paise, cgst_paise, sgst_paise, igst_paise, place_of_supply)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [p.serviceTxnId ?? null, p.serviceCode ?? null, basePaise, cgst, sgst, igst, p.placeOfSupply ?? null],
  );
  return { basePaise, gstPaise };
}
