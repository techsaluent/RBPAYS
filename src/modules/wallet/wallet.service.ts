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
  | 'adjustment'
  | 'commission'
  | 'activation_fee'
  | 'aeps'
  | 'cms'
  | 'card_swipe'
  | 'upi'
  | 'matm'
  | 'aadhaar_pay'
  | 'pan_card'
  | 'wallet_transfer'
  | 'travel'
  | 'insurance'
  | 'float_transfer'
  | 'withdrawal'
  | 'loan'
  | 'credit_card'
  | 'chargeback';

interface WalletRow {
  id: string;
  user_id: string;
  balance_paise: string;
  currency: string;
  frozen_at: string | null;
  frozen_reason: string | null;
  frozen_by: string | null;
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
    frozen: !!w.frozen_at,
    frozen_at: w.frozen_at,
    frozen_reason: w.frozen_reason,
    frozen_by: w.frozen_by,
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
  const holdRes = await query<{ total: string }>(
    "SELECT COALESCE(SUM(amount_paise),0) AS total FROM wallet_holds WHERE user_id = $1 AND status = 'active'",
    [userId],
  );
  const heldPaise = Number(holdRes.rows[0].total);
  const w = serialize(rows[0]);
  const availablePaise = w.balance_paise - heldPaise;
  return {
    ...w,
    held_paise: heldPaise,
    held: paiseToRupees(String(heldPaise)),
    available_paise: availablePaise,
    available: paiseToRupees(String(availablePaise)),
  };
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
export async function activeHoldTotalPaise(client: PoolClient, userId: string): Promise<number> {
  const { rows } = await client.query<{ total: string }>(
    "SELECT COALESCE(SUM(amount_paise),0) AS total FROM wallet_holds WHERE user_id = $1 AND status = 'active'",
    [userId],
  );
  return Number(rows[0].total);
}

export async function debit(client: PoolClient, p: LedgerParams): Promise<number> {
  if (p.amountPaise <= 0) throw ApiError.badRequest('Debit amount must be positive');
  const wallet = await lockWallet(client, p.userId);
  // A frozen wallet blocks every debit (services, transfers, withdrawals) until
  // an admin unfreezes it. Lien/holds only block a portion; a freeze blocks all.
  if (wallet.frozen_at) {
    throw ApiError.forbidden(
      `Wallet is frozen${wallet.frozen_reason ? `: ${wallet.frozen_reason}` : ''}`,
      { frozen: true, frozen_at: wallet.frozen_at, reason: wallet.frozen_reason ?? null },
    );
  }
  const balance = Number(wallet.balance_paise);
  // Spendable = balance minus any active lien/hold on the wallet.
  const held = await activeHoldTotalPaise(client, p.userId);
  const available = balance - held;
  if (available < p.amountPaise) {
    throw ApiError.unprocessable('Insufficient available balance (some funds are on hold)', {
      required_paise: p.amountPaise,
      available_paise: available,
      held_paise: held,
      balance_paise: balance,
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

// ---- Freeze / unfreeze --------------------------------------------------

/** Freeze a wallet: block ALL debits (see the guard in debit()). Idempotent. */
export async function freezeWallet(userId: string, adminId: string, reason?: string) {
  const { rows } = await query<WalletRow>(
    `UPDATE wallets
        SET frozen_at = now(), frozen_reason = $2, frozen_by = $3, updated_at = now()
      WHERE user_id = $1
      RETURNING *`,
    [userId, reason ?? null, adminId],
  );
  if (!rows[0]) throw ApiError.notFound('Wallet not found');
  return serialize(rows[0]);
}

/** Unfreeze a wallet: clears the freeze so debits resume. Idempotent. */
export async function unfreezeWallet(userId: string) {
  const { rows } = await query<WalletRow>(
    `UPDATE wallets
        SET frozen_at = NULL, frozen_reason = NULL, frozen_by = NULL, updated_at = now()
      WHERE user_id = $1
      RETURNING *`,
    [userId],
  );
  if (!rows[0]) throw ApiError.notFound('Wallet not found');
  return serialize(rows[0]);
}

// ---- Chargeback recovery from the upline --------------------------------

export interface ChargebackLeg {
  user_id: string;
  amount_paise: number;
  went_negative: boolean;
}

/**
 * Recover a chargeback loss starting from the member who caused it, cascading
 * any shortfall UP the parent_id chain. Each account gives what is spendable
 * (balance minus active holds); the remainder rolls to its parent. The top
 * account (no parent) absorbs whatever is left, which may push it negative —
 * it owes the platform. Every leg is written as a 'chargeback' debit ledger row
 * so it shows in each wallet's statement, plus one wallet_chargebacks audit row.
 *
 * MUST run inside withTransaction. Returns the recorded chargeback + its legs.
 */
export async function recoverChargeback(
  client: PoolClient,
  p: { originUserId: string; amountPaise: number; adminId: string; reason?: string; reference?: string },
): Promise<{ id: string; legs: ChargebackLeg[] }> {
  if (p.amountPaise <= 0) throw ApiError.badRequest('Chargeback amount must be positive');

  const legs: ChargebackLeg[] = [];
  let remaining = p.amountPaise;
  let currentUserId: string | null = p.originUserId;
  const visited = new Set<string>(); // guard against a cyclic parent chain

  while (remaining > 0 && currentUserId && !visited.has(currentUserId)) {
    visited.add(currentUserId);
    const wallet = await lockWallet(client, currentUserId);
    const balance = Number(wallet.balance_paise);
    const held = await activeHoldTotalPaise(client, currentUserId);
    const spendable = balance - held;

    const prow: { rows: Array<{ parent_id: string | null }> } = await client.query(
      'SELECT parent_id FROM users WHERE id = $1',
      [currentUserId],
    );
    const parentId: string | null = prow.rows[0]?.parent_id ?? null;

    // Take what this account can cover. If it can't cover the rest and has a
    // parent, take only what is spendable and cascade the shortfall up. If it
    // has no parent (top of the chain), it absorbs the whole remainder — which
    // may push it below zero.
    let take: number;
    if (spendable >= remaining) take = remaining;
    else if (parentId) take = Math.max(0, spendable);
    else take = remaining; // backstop account absorbs remainder

    if (take > 0) {
      const newBalance = balance - take;
      await client.query('UPDATE wallets SET balance_paise = $1, updated_at = now() WHERE id = $2', [
        newBalance,
        wallet.id,
      ]);
      // reference_id is a UUID column, so the free-text dispute reference lives
      // in the description (and the wallet_chargebacks audit row), not here.
      const desc =
        `Chargeback recovery${p.reference ? ` [${p.reference}]` : ''}${p.reason ? `: ${p.reason}` : ''}`;
      await client.query(
        `INSERT INTO wallet_transactions
           (wallet_id, direction, amount_paise, balance_after_paise, source, reference_id, description)
         VALUES ($1, 'debit', $2, $3, 'chargeback', NULL, $4)`,
        [wallet.id, take, newBalance, desc],
      );
      legs.push({ user_id: currentUserId, amount_paise: take, went_negative: newBalance < 0 });
      remaining -= take;
    }

    currentUserId = parentId;
  }

  if (remaining > 0) {
    // No account (not even the top) could absorb it — should not happen because
    // the parentless account takes the full remainder, but guard anyway.
    throw ApiError.unprocessable('Could not fully recover the chargeback from the upline chain', {
      recovered_paise: p.amountPaise - remaining,
      shortfall_paise: remaining,
    });
  }

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO wallet_chargebacks (origin_user_id, amount_paise, reason, reference, legs, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id`,
    [p.originUserId, p.amountPaise, p.reason ?? null, p.reference ?? null, JSON.stringify(legs), p.adminId],
  );
  return { id: rows[0].id, legs };
}
