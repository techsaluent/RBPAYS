import { withTransaction } from '../../../db';
import { logger } from '../../config/logger';
import { reverse } from '../wallet/wallet.service';
import { applyUplineCredits, CommissionEntry } from '../commission/commission.service';
import { ProviderResult } from '../../providers/types';

// service code -> detail table + whether it carries a UTR.
const SERVICE_TABLE: Record<string, { table: string; utr: boolean }> = {
  dmt: { table: 'dmt_transactions', utr: true },
  payout: { table: 'payout_transactions', utr: true },
  bbps: { table: 'bbps_transactions', utr: false },
  recharge: { table: 'recharge_transactions', utr: false },
};

interface TxnRow {
  id: string;
  user_id: string;
  service: string;
  service_txn_id: string;
  status: string;
  net_paise: string;
  reversed_at: string | null;
  commission_breakdown: CommissionEntry[] | null;
}

/**
 * Settle a transaction (identified by its unique reference) after the provider
 * responds. Updates the master ledger row and the service detail row, then:
 *   failed  -> reverse the NET debit exactly once (guarded by reversed_at)
 *   success -> credit upline commissions from the stored breakdown
 * Idempotent and safe to call from both the sync path and webhooks.
 */
export async function settleByReference(
  reference: string,
  providerName: string,
  result: ProviderResult,
): Promise<boolean> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<TxnRow>(
      'SELECT * FROM transactions WHERE reference = $1 FOR UPDATE',
      [reference],
    );
    const txn = rows[0];
    if (!txn) {
      logger.warn({ reference }, 'settle: transaction not found');
      return false;
    }
    if (['success', 'failed', 'refunded'].includes(txn.status)) return true; // terminal

    // Master ledger row.
    await client.query(
      'UPDATE transactions SET status = $1, provider = $2, status_message = $3 WHERE id = $4',
      [result.status, providerName, result.message ?? null, txn.id],
    );

    // Service detail row.
    const svc = SERVICE_TABLE[txn.service];
    if (svc && txn.service_txn_id) {
      await client.query(
        `UPDATE ${svc.table}
            SET status = $1, provider = $2, status_message = $3,
                provider_ref = COALESCE($4, provider_ref)
          WHERE id = $5`,
        [result.status, providerName, result.message ?? null, result.providerRef ?? null, txn.service_txn_id],
      );
      if (svc.utr && result.utr) {
        await client.query(`UPDATE ${svc.table} SET utr = $1 WHERE id = $2`, [
          result.utr,
          txn.service_txn_id,
        ]);
      }
    }

    if (result.status === 'failed' && !txn.reversed_at) {
      await reverse(client, {
        userId: txn.user_id,
        amountPaise: Number(txn.net_paise),
        referenceId: txn.id,
        description: `Reversal for failed ${txn.service} (${reference})`,
      });
      await client.query('UPDATE transactions SET reversed_at = now() WHERE id = $1', [txn.id]);
      if (svc && txn.service_txn_id) {
        await client.query(`UPDATE ${svc.table} SET reversed_at = now() WHERE id = $1`, [
          txn.service_txn_id,
        ]);
      }
    }

    if (result.status === 'success' && txn.commission_breakdown?.length) {
      await applyUplineCredits(client, {
        serviceTxnId: txn.service_txn_id,
        service: txn.service,
        performerId: txn.user_id,
        entries: txn.commission_breakdown,
      });
    }

    return true;
  });
}
