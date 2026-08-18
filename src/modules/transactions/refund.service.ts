import { query, withTransaction } from '../../../db';
import { ApiError } from '../../utils/ApiError';
import { reverse, debit } from '../wallet/wallet.service';
import { debitSub } from '../wallet/subwallet.service';
import { commissionTds } from '../tax/tax.service';
import { settleByReference } from '../_shared/settle';

// service code -> detail table (for the status flip on refund).
const SERVICE_TABLE: Record<string, string> = {
  dmt: 'dmt_transactions',
  payout: 'payout_transactions',
  bbps: 'bbps_transactions',
  recharge: 'recharge_transactions',
  cms: 'cms_transactions',
  upi: 'upi_transactions',
  pan_card: 'pan_card_transactions',
  travel: 'travel_transactions',
  insurance: 'insurance_transactions',
  aadhaar_pay: 'aadhaar_pay_transactions',
  card_swipe: 'card_swipe_transactions',
  aeps: 'aeps_transactions',
  matm: 'matm_transactions',
};

interface TxnRow {
  id: string;
  user_id: string;
  service: string;
  direction: string;
  service_txn_id: string;
  reference: string;
  status: string;
  net_paise: string;
  provider: string | null;
  reversed_at: string | null;
}

/**
 * Refund a successful debit-flow transaction: credit the payer back the net
 * amount they paid and claw back the commission that was distributed to the
 * upline (distributor/MD from their Commission wallet, admin from the main
 * wallet). Atomic: if a beneficiary already withdrew their commission the
 * whole refund rolls back so the ledger never goes negative — resolve that
 * case with a manual adjustment first.
 */
export async function refundTransaction(txnId: string, remark: string) {
  return withTransaction(async (client) => {
    const { rows } = await client.query<TxnRow>('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [txnId]);
    const txn = rows[0];
    if (!txn) throw ApiError.notFound('Transaction not found');
    if (txn.status !== 'success') throw ApiError.badRequest('Only a successful transaction can be refunded');
    if (txn.direction !== 'debit') throw ApiError.badRequest('Only debit-flow services can be refunded here');
    if (txn.reversed_at) throw ApiError.conflict('Transaction already reversed or refunded');

    const net = Number(txn.net_paise);
    // 1) Refund the payer the net amount they were debited.
    if (net > 0) {
      await reverse(client, {
        userId: txn.user_id,
        amountPaise: net,
        referenceId: txn.id,
        description: `Refund for ${txn.service} (${txn.reference})`,
      });
    }

    // 2) Claw back the commission distributed on this transaction.
    const ce = await client.query<{ level: string; beneficiary_id: string; amount_paise: string }>(
      'SELECT level, beneficiary_id, amount_paise FROM commission_entries WHERE service_txn_id = $1',
      [txn.service_txn_id],
    );
    for (const e of ce.rows) {
      const gross = Number(e.amount_paise);
      if (gross <= 0) continue;
      if (e.level === 'retailer') continue; // realised via the reduced debit (refunded above)
      if (e.level === 'admin') {
        await debit(client, {
          userId: e.beneficiary_id,
          amountPaise: gross,
          source: 'adjustment',
          referenceId: txn.id,
          description: `Commission clawback (refund ${txn.reference})`,
        });
      } else {
        // Distributor / MD were paid net of 194H TDS into their Commission wallet.
        const { tdsPaise } = await commissionTds(e.beneficiary_id, gross);
        const netComm = gross - tdsPaise;
        if (netComm > 0) await debitSub(client, e.beneficiary_id, 'commission', netComm);
      }
    }

    // 3) Mark the transaction refunded (master + detail row).
    await client.query(
      "UPDATE transactions SET status = 'refunded', reversed_at = now(), status_message = $2 WHERE id = $1",
      [txn.id, `Refunded: ${remark}`],
    );
    const table = SERVICE_TABLE[txn.service];
    if (table && txn.service_txn_id) {
      await client.query(`UPDATE ${table} SET status = 'refunded' WHERE id = $1`, [txn.service_txn_id]);
    }
    const upd = await client.query('SELECT * FROM transactions WHERE id = $1', [txn.id]);
    return upd.rows[0];
  });
}

/**
 * Resolve a stuck pending transaction to success or failed. Reuses the same
 * settlement path as the sync/webhook flow (reverses the debit on failure,
 * pays upline on success), so it's correct and idempotent.
 */
export async function resolvePending(txnId: string, decision: 'success' | 'failed', remark: string) {
  const { rows } = await query<{ reference: string; provider: string | null; status: string }>(
    'SELECT reference, provider, status FROM transactions WHERE id = $1',
    [txnId],
  );
  const txn = rows[0];
  if (!txn) throw ApiError.notFound('Transaction not found');
  if (txn.status !== 'pending') throw ApiError.badRequest('Only a pending transaction can be resolved');
  await settleByReference(txn.reference, txn.provider || 'manual', {
    status: decision,
    message: `Manually resolved: ${remark}`,
  });
  const upd = await query('SELECT * FROM transactions WHERE id = $1', [txnId]);
  return upd.rows[0];
}
