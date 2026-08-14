import { PoolClient } from 'pg';
import { query, withTransaction } from '../../../db';
import { debit, WalletSource } from '../wallet/wallet.service';
import { computeDistribution } from '../commission/commission.service';
import { settleByReference } from './settle';
import { makeReference } from '../../utils/reference';
import { ProviderResult } from '../../providers/types';

export interface RunOptions {
  userId: string;
  serviceCode: string; // dmt | bbps | recharge | payout
  table: string; // detail table name
  prefix: string; // reference prefix, e.g. DMT
  reference?: string; // client reference / Idempotency-Key
  amountPaise: number;
  clientChargePaise?: number; // used only when no commission rule matches
  description: string;
  providerName: string;
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

  // 2) Compute the money split up front so the retailer is netted.
  const dist = await computeDistribution(opts.userId, opts.serviceCode, opts.amountPaise);
  const chargePaise = dist.ruleMatched ? dist.chargePaise : opts.clientChargePaise ?? 0;
  const netPaise = Math.max(0, opts.amountPaise + chargePaise - dist.retailerPaise);

  let ids: { serviceTxnId: string; masterId: string };
  try {
    ids = await withTransaction(async (client) => {
      const serviceTxnId = await opts.insertServiceRow(client, { reference, chargePaise });
      const master = await client.query<{ id: string }>(
        `INSERT INTO transactions
           (user_id, service, direction, service_txn_id, reference,
            amount_paise, charge_paise, commission_paise, net_paise, status, commission_breakdown)
         VALUES ($1,$2,'debit',$3,$4,$5,$6,$7,$8,'pending',$9)
         RETURNING id`,
        [
          opts.userId,
          opts.serviceCode,
          serviceTxnId,
          reference,
          opts.amountPaise,
          chargePaise,
          dist.retailerPaise,
          netPaise,
          JSON.stringify(dist.entries),
        ],
      );
      await debit(client, {
        userId: opts.userId,
        amountPaise: netPaise,
        source: opts.serviceCode as WalletSource,
        referenceId: serviceTxnId,
        description: opts.description,
      });
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
