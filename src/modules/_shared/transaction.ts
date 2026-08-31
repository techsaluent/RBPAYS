import crypto from 'crypto';
import { PoolClient } from 'pg';
import { query, withTransaction } from '../../../db';
import { debit, WalletSource } from '../wallet/wallet.service';
import { computeDistribution } from '../commission/commission.service';
import { assessTransaction } from '../risk/risk.service';
import { settleByReference } from './settle';
import { makeReference } from '../../utils/reference';
import { ApiError } from '../../utils/ApiError';
import { notifyLowBalance } from '../notify/alerts';
import { ProviderResult } from '../../providers/types';

export interface RunOptions {
  userId: string;
  serviceCode: string; // dmt | bbps | recharge | payout | cms | aeps | card_swipe
  table: string; // detail table name
  prefix: string; // reference prefix, e.g. DMT
  reference?: string; // client reference / Idempotency-Key
  amountPaise: number;
  clientChargePaise?: number; // used only when no commission rule matches
  description: string;
  providerName: string;
  /**
   * debit  (default): retailer pays; net = amount + charge - retailer_commission.
   * credit          : retailer receives; net = amount + retailer_commission - charge.
   *   AEPS earns commission (charge 0); Card Swipe is charged the MDR (charge > 0).
   */
  flow?: 'debit' | 'credit';
  /** The specific provider chosen for this transaction (routing + commission). */
  providerId?: string;
  /**
   * Strip hierarchy commission for this transaction (e.g. AePS split /
   * commission-farming detected). The transaction still executes.
   */
  suppressCommission?: boolean;
  /**
   * Details that make this transaction unique (account no, VPA, consumer no…).
   * Used to block an accidental duplicate submit of the SAME transaction within
   * the admin-configured window. Falls back to `description` when not given.
   */
  dedupeKey?: string;
  /** Insert the service detail row (pending). Return its id. */
  insertServiceRow: (client: PoolClient, ctx: { reference: string; chargePaise: number }) => Promise<string>;
  /** Call the external provider (runs after the debit commits). */
  callProvider: (ctx: { reference: string }) => Promise<ProviderResult>;
}

export interface RunResult {
  transaction: Record<string, unknown>; // service detail row
  master: Record<string, unknown>; // transactions ledger row
  idempotent: boolean;
}

/** Admin-configured duplicate window in minutes (0 = disabled). Default 5. */
async function duplicateWindowMinutes(): Promise<number> {
  const { rows } = await query<{ value: string | null }>(
    "SELECT value FROM site_settings WHERE key = 'duplicate_txn_window_minutes'",
  );
  const n = Number(rows[0]?.value);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

/**
 * Reject an identical transaction (same member + service + amount + details)
 * that was submitted within the admin window and is still pending or already
 * succeeded. A previous *failed* attempt does not block a retry.
 */
async function guardDuplicate(
  userId: string,
  serviceCode: string,
  dedupeHash: string,
): Promise<void> {
  const minutes = await duplicateWindowMinutes();
  if (minutes <= 0) return;
  const { rows } = await query<{ reference: string }>(
    `SELECT reference FROM transactions
      WHERE user_id = $1 AND dedupe_hash = $2
        AND status IN ('pending', 'success')
        AND created_at > now() - ($3 || ' minutes')::interval
      ORDER BY created_at DESC LIMIT 1`,
    [userId, dedupeHash, String(minutes)],
  );
  if (rows[0]) {
    throw ApiError.conflict(
      `Duplicate transaction blocked — an identical ${serviceCode} was submitted in the last ${minutes} minute(s) (ref ${rows[0].reference}). Please wait before retrying.`,
    );
  }
}

/**
 * KYC gate: when the admin has switched on "require KYC to transact"
 * (site setting security_require_kyc), a member must be KYC-verified before any
 * money-movement transaction. Off by default so nothing changes unless enabled.
 */
async function guardKyc(userId: string): Promise<void> {
  const { rows } = await query<{ require_kyc: string | null; kyc_status: string }>(
    `SELECT (SELECT value FROM site_settings WHERE key = 'security_require_kyc') AS require_kyc,
            (SELECT kyc_status FROM users WHERE id = $1) AS kyc_status`,
    [userId],
  );
  const r = rows[0];
  if (r?.require_kyc === 'true' && r.kyc_status !== 'verified') {
    throw ApiError.forbidden('Complete your KYC verification before transacting.');
  }
}

async function loadExisting(reference: string, table: string): Promise<RunResult | null> {
  const master = await query('SELECT * FROM transactions WHERE reference = $1', [reference]);
  if (!master.rows[0]) return null;
  const m = master.rows[0] as { service_txn_id: string };
  const detail = await query(`SELECT * FROM ${table} WHERE id = $1`, [m.service_txn_id]);
  return { transaction: detail.rows[0], master: master.rows[0], idempotent: true };
}

/**
 * Run a debit-based service transaction with net-commission and idempotency:
 *   1. If `reference` was already used, return the original (no double charge).
 *   2. Compute charge + commission; NET-debit the retailer (amount + charge
 *      - retailer commission) alongside the detail + ledger rows, atomically.
 *   3. Call the provider, then settle (reverse on failure / pay upline on success).
 */
export async function runServiceTransaction(opts: RunOptions): Promise<RunResult> {
  const reference = opts.reference?.trim() || makeReference(opts.prefix);

  // 1) Idempotency: a used reference returns the original transaction.
  const existing = await loadExisting(reference, opts.table);
  if (existing) return existing;

  // 1a) Duplicate-details guard: same member + service + amount + flow +
  //     details (account/VPA/consumer no…). Blocks an accidental re-submit
  //     within the admin-configured window; a fresh reference each time means
  //     idempotency alone can't catch this.
  const flowForHash = opts.flow ?? 'debit';
  const dedupeHash = crypto
    .createHash('sha256')
    .update(
      [opts.userId, opts.serviceCode, flowForHash, opts.amountPaise, opts.dedupeKey ?? opts.description]
        .join('|')
        .toLowerCase(),
    )
    .digest('hex');
  await guardDuplicate(opts.userId, opts.serviceCode, dedupeHash);

  // 1a-ii) KYC gate (opt-in): block un-verified members when the admin requires it.
  await guardKyc(opts.userId);

  // 1b) Risk / AML pre-check (throws 422 when the action is 'block').
  await assessTransaction({
    userId: opts.userId,
    service: opts.serviceCode,
    amountPaise: opts.amountPaise,
    reference,
  });

  // 2) Compute the money split up front so the retailer is netted.
  const flow = opts.flow ?? 'debit';
  const dist = opts.suppressCommission
    ? { ruleMatched: false, chargePaise: 0, retailerPaise: 0, entries: [] }
    : await computeDistribution(opts.userId, opts.serviceCode, opts.amountPaise, opts.providerId);
  const chargePaise = dist.ruleMatched ? dist.chargePaise : opts.clientChargePaise ?? 0;
  const netPaise =
    flow === 'credit'
      ? Math.max(0, opts.amountPaise + dist.retailerPaise - chargePaise) // received on success
      : Math.max(0, opts.amountPaise + chargePaise - dist.retailerPaise); // debited now

  let ids: { serviceTxnId: string; masterId: string };
  let debitedBalance: number | null = null;
  try {
    ids = await withTransaction(async (client) => {
      const serviceTxnId = await opts.insertServiceRow(client, { reference, chargePaise });
      const master = await client.query<{ id: string }>(
        `INSERT INTO transactions
           (user_id, service, direction, service_txn_id, reference,
            amount_paise, charge_paise, commission_paise, net_paise, status, commission_breakdown, provider_id, dedupe_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12)
         RETURNING id`,
        [
          opts.userId,
          opts.serviceCode,
          flow, // direction: 'debit' | 'credit'
          serviceTxnId,
          reference,
          opts.amountPaise,
          chargePaise,
          dist.retailerPaise,
          netPaise,
          JSON.stringify(dist.entries),
          opts.providerId ?? null,
          dedupeHash,
        ],
      );
      // Debit flow reserves funds now; credit flow settles the wallet on success.
      if (flow === 'debit') {
        debitedBalance = await debit(client, {
          userId: opts.userId,
          amountPaise: netPaise,
          source: opts.serviceCode as WalletSource,
          referenceId: serviceTxnId,
          description: opts.description,
        });
      }
      return { serviceTxnId, masterId: master.rows[0].id };
    });
  } catch (err) {
    // Concurrent duplicate submit: unique(reference) violation -> return original.
    if ((err as { code?: string }).code === '23505') {
      const dup = await loadExisting(reference, opts.table);
      if (dup) return dup;
    }
    throw err;
  }

  // Low-balance alert (best-effort) if this debit crossed the admin threshold.
  if (debitedBalance != null) void notifyLowBalance(opts.userId, debitedBalance + netPaise, debitedBalance);

  // 3) Provider call + settle (outside the reserve transaction).
  const result = await opts.callProvider({ reference });
  await settleByReference(reference, opts.providerName, result);

  const detail = await query(`SELECT * FROM ${opts.table} WHERE id = $1`, [ids.serviceTxnId]);
  const master = await query('SELECT * FROM transactions WHERE id = $1', [ids.masterId]);
  return { transaction: detail.rows[0], master: master.rows[0], idempotent: false };
}
