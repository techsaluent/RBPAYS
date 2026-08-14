import { withTransaction } from '../../../db';
import { logger } from '../../config/logger';
import { credit, reverse, WalletSource } from '../wallet/wallet.service';
import { applyUplineCredits, CommissionEntry } from '../commission/commission.service';
import { ProviderResult } from '../../providers/types';

// service code -> detail table + which optional fields it carries.
const SERVICE_TABLE: Record<string, { table: string; utr?: boolean; rrn?: boolean; balance?: boolean }> = {
  dmt: { table: 'dmt_transactions', utr: true },
  payout: { table: 'payout_transactions', utr: true },
  bbps: { table: 'bbps_transactions' },
  recharge: { table: 'recharge_transactions' },
  cms: { table: 'cms_transactions' },
  aeps: { table: 'aeps_transactions', rrn: true, balance: true },
  card_swipe: { table: 'card_swipe_transactions', rrn: true },
};

interface TxnRow {
  id: string;
  user_id: string;
  service: string;
  direction: string; // 'debit' | 'credit'
  service_txn_id: string;
  status: string;
  net_paise: string;
  reversed_at: string | null;
  commission_breakdown: CommissionEntry[] | null;
}

/**
 * Settle a transaction (by its unique reference) after the provider responds.
 * Updates the master ledger + service detail row, then applies wallet effects:
 *
 *   debit flow  — failed: reverse the net debit once; success: credit upline only
 *   credit flow — failed: nothing to undo; success: credit the retailer the net
 *                 amount AND credit upline
 *
 * Idempotent and safe from both the sync path and webhooks.
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

    await client.query(
      'UPDATE transactions SET status = $1, provider = $2, status_message = $3 WHERE id = $4',
      [result.status, providerName, result.message ?? null, txn.id],
    );

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
        await client.query(`UPDATE ${svc.table} SET utr = $1 WHERE id = $2`, [result.utr, txn.service_txn_id]);
      }
      if (svc.rrn && result.rrn) {
        await client.query(`UPDATE ${svc.table} SET rrn = $1 WHERE id = $2`, [result.rrn, txn.service_txn_id]);
      }
      if (svc.balance && result.balancePaise != null) {
        await client.query(`UPDATE ${svc.table} SET balance_paise = $1 WHERE id = $2`, [
          result.balancePaise,
          txn.service_txn_id,
        ]);
      }
    }

    if (result.status === 'failed' && txn.direction === 'debit' && !txn.reversed_at) {
      await reverse(client, {
        userId: txn.user_id,
        amountPaise: Number(txn.net_paise),
        referenceId: txn.id,
        description: `Reversal for failed ${txn.service} (${reference})`,
      });
      await client.query('UPDATE transactions SET reversed_at = now() WHERE id = $1', [txn.id]);
      if (svc && txn.service_txn_id) {
        await client.query(`UPDATE ${svc.table} SET reversed_at = now() WHERE id = $1`, [txn.service_txn_id]);
      }
    }

    if (result.status === 'success') {
      // Credit flow: settle the received amount into the retailer's wallet.
      if (txn.direction === 'credit' && Number(txn.net_paise) > 0) {
        await credit(client, {
          userId: txn.user_id,
          amountPaise: Number(txn.net_paise),
          source: txn.service as WalletSource,
          referenceId: txn.id,
          description: `${txn.service} settlement (${reference})`,
        });
      }
      // Upline commissions (retailer's own commission is already realised:
      // netted into the debit, or included in the credit above).
      if (txn.commission_breakdown?.length) {
        await applyUplineCredits(client, {
          serviceTxnId: txn.service_txn_id,
          service: txn.service,
          performerId: txn.user_id,
          entries: txn.commission_breakdown,
        });
      }
    }

    return true;
  });
}
