import { PoolClient } from 'pg';
import { query, withTransaction } from '../../../db';
import { debit, WalletSource } from '../wallet/wallet.service';
import { computeDistribution } from '../commission/commission.service';
import { assessTransaction } from '../risk/risk.service';
import { settleByReference } from './settle';
import { makeReference } from '../../utils/reference';
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
  try {
    ids = await withTransaction(async (client) => {
      const serviceTxnId = await opts.insertServiceRow(client, { reference, chargePaise });
      const master = await client.query<{ id: string }>(
        `INSERT INTO transactions
           (user_id, service, direction, service_txn_id, reference,
            amount_paise, charge_paise, commission_paise, net_paise, status, commission_breakdown, provider_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11)
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
        ],
      );
      // Debit flow reserves funds now; credit flow settles the wallet on success.
      if (flow === 'debit') {
        await debit(client, {
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

  // 3) Provider call + settle (outside the reserve transaction).
  const result = await opts.callProvider({ reference });
  await settleByReference(reference, opts.providerName, result);

  const detail = await query(`SELECT * FROM ${opts.table} WHERE id = $1`, [ids.serviceTxnId]);
  const master = await query('SELECT * FROM transactions WHERE id = $1', [ids.masterId]);
  return { transaction: detail.rows[0], master: master.rows[0], idempotent: false };
}
