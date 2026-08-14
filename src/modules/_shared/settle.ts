import { PoolClient } from 'pg';
import { withTransaction } from '../../../db';
import { logger } from '../../config/logger';
import { reverse } from '../wallet/wallet.service';
import { ProviderResult } from '../../providers/types';

// Whitelist of debit-based service tables and whether they carry a UTR.
const TABLES = {
  dmt_transactions: { utr: true },
  payout_transactions: { utr: true },
  bbps_transactions: { utr: false },
  recharge_transactions: { utr: false },
} as const;

export type ServiceTable = keyof typeof TABLES;

interface LockedRow {
  id: string;
  user_id: string;
  status: string;
  reversed_at: string | null;
  amount_paise: string;
  charge_paise: string;
}

/**
 * Apply a provider result to an already-locked service-transaction row.
 *   success -> mark success, store provider ref/utr
 *   pending -> mark pending (webhook/poll will finalize later)
 *   failed  -> mark failed AND reverse the wallet debit exactly once
 * Idempotent: terminal rows are left untouched; reversal guarded by reversed_at.
 */
async function applyResult(
  client: PoolClient,
  table: ServiceTable,
  row: LockedRow,
  providerName: string,
  result: ProviderResult,
): Promise<void> {
  if (row.status === 'success' || row.status === 'failed' || row.status === 'refunded') {
    return; // already terminal
  }

  const meta = TABLES[table];
  const utrClause = meta.utr ? ', utr = COALESCE($5, utr)' : '';
  const params: unknown[] = [
    result.status,
    providerName,
    result.message ?? null,
    result.providerRef ?? null,
  ];
  if (meta.utr) params.push(result.utr ?? null);

  await client.query(
    `UPDATE ${table}
        SET status = $1, provider = $2, status_message = $3,
            provider_ref = COALESCE($4, provider_ref)${utrClause}
      WHERE id = ${meta.utr ? '$6' : '$5'}`,
    [...params, row.id],
  );

  if (result.status === 'failed' && !row.reversed_at) {
    const refundPaise = Number(row.amount_paise) + Number(row.charge_paise);
    await reverse(client, {
      userId: row.user_id,
      amountPaise: refundPaise,
      referenceId: row.id,
      description: `Reversal for failed ${table.replace('_transactions', '')} (${row.id})`,
    });
    await client.query(`UPDATE ${table} SET reversed_at = now() WHERE id = $1`, [row.id]);
  }
}

const SELECT_COLS = 'id, user_id, status, reversed_at, amount_paise, charge_paise';

/** Settle a service transaction identified by id + owner (synchronous path). */
export async function settleServiceTxn(p: {
  table: ServiceTable;
  txnId: string;
  userId: string;
  providerName: string;
  result: ProviderResult;
}): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<LockedRow>(
      `SELECT ${SELECT_COLS} FROM ${p.table} WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [p.txnId, p.userId],
    );
    if (!rows[0]) {
      logger.warn({ table: p.table, txnId: p.txnId }, 'settle: transaction not found');
      return;
    }
    await applyResult(client, p.table, rows[0], p.providerName, p.result);
  });
}

/** Settle a service transaction identified by its unique reference (webhook path). */
export async function settleServiceByReference(p: {
  table: ServiceTable;
  reference: string;
  providerName: string;
  result: ProviderResult;
}): Promise<boolean> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<LockedRow>(
      `SELECT ${SELECT_COLS} FROM ${p.table} WHERE reference = $1 FOR UPDATE`,
      [p.reference],
    );
    if (!rows[0]) {
      logger.warn({ table: p.table, reference: p.reference }, 'settle: reference not found');
      return false;
    }
    await applyResult(client, p.table, rows[0], p.providerName, p.result);
    return true;
  });
}
