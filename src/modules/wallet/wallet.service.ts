import { PoolClient } from 'pg';
import { query } from '../../../db';
import { ApiError } from '../../utils/ApiError';
import { bigintToNumber, paiseToRupees } from '../../utils/money';

export type WalletSource =
  | 'topup'
  | 'dmt'
  | 'bbps'
  | 'recharge'
  | 'payout'
  | 'payment_gateway'
  | 'reversal'
  | 'adjustment';

interface WalletRow {
  id: string;
  user_id: string;
  balance_paise: string;
  currency: string;
  created_at: string;
  updated_at: string;
}

function serialize(w: WalletRow) {
  return {
    id: w.id,
    user_id: w.user_id,
    balance_paise: bigintToNumber(w.balance_paise),
    balance: paiseToRupees(w.balance_paise),
    currency: w.currency,
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
}

export async function getWalletByUser(userId: string) {
  const { rows } = await query<WalletRow>(
    'SELECT * FROM wallets WHERE user_id = $1',
    [userId],
  );
  if (!rows[0]) throw ApiError.notFound('Wallet not found');
  return serialize(rows[0]);
}

/**
 * Lock and return a user's wallet row inside an existing transaction.
 * Always call this before mutating balance so concurrent debits serialise.
 */
async function lockWallet(client: PoolClient, userId: string): Promise<WalletRow> {
  const { rows } = await client.query<WalletRow>(
    'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
    [userId],
  );
  if (!rows[0]) throw ApiError.notFound('Wallet not found');
  return rows[0];
}

interface LedgerParams {
  userId: string;
  amountPaise: number;
  source: WalletSource;
  referenceId?: string;
  description?: string;
}

/**
 * Debit a wallet atomically, writing a ledger row. Throws 422 on insufficient
 * balance. MUST be called inside withTransaction (needs the same client).
 * Returns the new balance in paise.
 */
export async function debit(client: PoolClient, p: LedgerParams): Promise<number> {
  if (p.amountPaise <= 0) throw ApiError.badRequest('Debit amount must be positive');
  const wallet = await lockWallet(client, p.userId);
  const balance = Number(wallet.balance_paise);
  if (balance < p.amountPaise) {
    throw ApiError.unprocessable('Insufficient wallet balance', {
      required_paise: p.amountPaise,
      available_paise: balance,
    });
  }
  const newBalance = balance - p.amountPaise;
  await client.query('UPDATE wallets SET balance_paise = $1 WHERE id = $2', [
    newBalance,
    wallet.id,
  ]);
  await client.query(
    `INSERT INTO wallet_transactions
       (wallet_id, direction, amount_paise, balance_after_paise, source, reference_id, description)
     VALUES ($1, 'debit', $2, $3, $4, $5, $6)`,
    [wallet.id, p.amountPaise, newBalance, p.source, p.referenceId ?? null, p.description ?? null],
  );
  return newBalance;
}

/** Credit a wallet atomically, writing a ledger row. Returns new balance in paise. */
export async function credit(client: PoolClient, p: LedgerParams): Promise<number> {
  if (p.amountPaise <= 0) throw ApiError.badRequest('Credit amount must be positive');
  const wallet = await lockWallet(client, p.userId);
  const newBalance = Number(wallet.balance_paise) + p.amountPaise;
  await client.query('UPDATE wallets SET balance_paise = $1 WHERE id = $2', [
    newBalance,
    wallet.id,
  ]);
  await client.query(
    `INSERT INTO wallet_transactions
       (wallet_id, direction, amount_paise, balance_after_paise, source, reference_id, description)
     VALUES ($1, 'credit', $2, $3, $4, $5, $6)`,
    [wallet.id, p.amountPaise, newBalance, p.source, p.referenceId ?? null, p.description ?? null],
  );
  return newBalance;
}

/**
 * Reverse a previously debited amount back into the wallet (e.g. a service
 * transaction failed at the provider). Writes a 'reversal' ledger row.
 * MUST run inside withTransaction. Returns the new balance in paise.
 */
export async function reverse(
  client: PoolClient,
  p: Omit<LedgerParams, 'source'>,
): Promise<number> {
  return credit(client, { ...p, source: 'reversal' });
}

/** Paginated ledger for a user's wallet. */
export async function listLedger(userId: string, limit = 20, offset = 0) {
  const { rows } = await query(
    `SELECT wt.id, wt.direction, wt.amount_paise, wt.balance_after_paise,
            wt.source, wt.reference_id, wt.description, wt.created_at
       FROM wallet_transactions wt
       JOIN wallets w ON w.id = wt.wallet_id
      WHERE w.user_id = $1
      ORDER BY wt.created_at DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  return rows.map((r) => ({
    ...r,
    amount_paise: bigintToNumber(r.amount_paise as string),
    amount: paiseToRupees(r.amount_paise as string),
    balance_after_paise: bigintToNumber(r.balance_after_paise as string),
    balance_after: paiseToRupees(r.balance_after_paise as string),
  }));
}
