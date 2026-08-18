import { withTransaction } from '../../../db';
import { ApiError } from '../../utils/ApiError';
import { debit, credit } from '../wallet/wallet.service';
import { postJournal } from '../_shared/ledger';
import { makeReference } from '../../utils/reference';

export interface WithdrawInput {
  amountPaise: number;
  accountName: string;
  accountNumber: string;
  ifsc: string;
  mode: 'IMPS' | 'NEFT' | 'RTGS';
}

/**
 * A member requests a cash-out of their wallet to their bank. The wallet is
 * debited immediately (respecting active holds) and the amount moves into
 * payout_clearing; admin later marks it paid or rejects (which refunds it).
 */
export async function requestWithdrawal(userId: string, input: WithdrawInput) {
  const reference = makeReference('WD');
  return withTransaction(async (client) => {
    // Create the request row first so the wallet ledger can reference its UUID.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO wallet_withdrawals (user_id, amount_paise, account_name, account_number, ifsc, mode, reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [userId, input.amountPaise, input.accountName, input.accountNumber, input.ifsc, input.mode, reference],
    );
    const w = rows[0];
    await debit(client, {
      userId,
      amountPaise: input.amountPaise,
      source: 'withdrawal',
      referenceId: w.id,
      description: `Withdrawal to bank ${input.accountNumber}`,
    });
    await postJournal(client, {
      source: 'withdrawal',
      reference,
      narration: 'Wallet withdrawal requested',
      lines: [
        { account: 'member_wallet', direction: 'debit', amountPaise: input.amountPaise, walletUserId: userId },
        { account: 'payout_clearing', direction: 'credit', amountPaise: input.amountPaise },
      ],
    });
    return w;
  });
}

/** Admin marks a withdrawal paid (cash left the escrow to the member's bank). */
export async function approveWithdrawal(id: string, adminId: string, utr?: string, remarks?: string) {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; amount_paise: string; status: string; reference: string }>(
      'SELECT id, amount_paise, status, reference FROM wallet_withdrawals WHERE id = $1 FOR UPDATE',
      [id],
    );
    const w = rows[0];
    if (!w) throw ApiError.notFound('Withdrawal not found');
    if (w.status !== 'pending') throw ApiError.conflict(`Withdrawal already ${w.status}`);
    const amt = Number(w.amount_paise);
    await postJournal(client, {
      source: 'withdrawal',
      reference: w.reference,
      narration: 'Wallet withdrawal paid',
      lines: [
        { account: 'payout_clearing', direction: 'debit', amountPaise: amt },
        { account: 'bank_escrow', direction: 'credit', amountPaise: amt },
      ],
    });
    const upd = await client.query(
      `UPDATE wallet_withdrawals SET status='paid', utr=$1, remarks=$2, decided_by=$3, decided_at=now()
        WHERE id=$4 RETURNING *`,
      [utr ?? null, remarks ?? null, adminId, id],
    );
    return upd.rows[0];
  });
}

/** Admin rejects a withdrawal — refunds the wallet. */
export async function rejectWithdrawal(id: string, adminId: string, remarks?: string) {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; user_id: string; amount_paise: string; status: string; reference: string }>(
      'SELECT id, user_id, amount_paise, status, reference FROM wallet_withdrawals WHERE id = $1 FOR UPDATE',
      [id],
    );
    const w = rows[0];
    if (!w) throw ApiError.notFound('Withdrawal not found');
    if (w.status !== 'pending') throw ApiError.conflict(`Withdrawal already ${w.status}`);
    const amt = Number(w.amount_paise);
    await credit(client, {
      userId: w.user_id,
      amountPaise: amt,
      source: 'withdrawal',
      referenceId: w.id,
      description: 'Withdrawal rejected — refund',
    });
    await postJournal(client, {
      source: 'withdrawal',
      reference: w.reference,
      narration: 'Wallet withdrawal rejected (refund)',
      lines: [
        { account: 'payout_clearing', direction: 'debit', amountPaise: amt },
        { account: 'member_wallet', direction: 'credit', amountPaise: amt, walletUserId: w.user_id },
      ],
    });
    const upd = await client.query(
      `UPDATE wallet_withdrawals SET status='rejected', remarks=$1, decided_by=$2, decided_at=now()
        WHERE id=$3 RETURNING *`,
      [remarks ?? null, adminId, id],
    );
    return upd.rows[0];
  });
}
