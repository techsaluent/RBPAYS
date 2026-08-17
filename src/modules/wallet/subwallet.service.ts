import { PoolClient } from 'pg';
import { query } from '../../../db';
import { ApiError } from '../../utils/ApiError';
import { bigintToNumber, paiseToRupees } from '../../utils/money';

/**
 * Sub-wallets hold balances distinct from the pre-funded Main wallet:
 *   settlement — AePS / mATM customer cash-out inflow owed to the member
 *   commission — commission earnings, net of TDS
 * Members sweep these into the Main wallet (or settle to bank).
 */
export type SubWalletType = 'settlement' | 'commission';

/** Credit a sub-wallet atomically (upserts the row). MUST run in a txn. */
export async function creditSub(
  client: PoolClient,
  userId: string,
  type: SubWalletType,
  amountPaise: number,
): Promise<number> {
  if (amountPaise <= 0) throw ApiError.badRequest('Credit must be positive');
  const { rows } = await client.query<{ balance_paise: string }>(
    `INSERT INTO sub_wallets (user_id, wallet_type, balance_paise)
     VALUES ($1,$2,$3)
     ON CONFLICT (user_id, wallet_type)
     DO UPDATE SET balance_paise = sub_wallets.balance_paise + EXCLUDED.balance_paise
     RETURNING balance_paise`,
    [userId, type, amountPaise],
  );
  return Number(rows[0].balance_paise);
}

/** Debit a sub-wallet atomically under a row lock. Throws 422 if short. */
export async function debitSub(
  client: PoolClient,
  userId: string,
  type: SubWalletType,
  amountPaise: number,
): Promise<number> {
  if (amountPaise <= 0) throw ApiError.badRequest('Debit must be positive');
  const { rows } = await client.query<{ balance_paise: string }>(
    'SELECT balance_paise FROM sub_wallets WHERE user_id = $1 AND wallet_type = $2 FOR UPDATE',
    [userId, type],
  );
  const bal = rows[0] ? Number(rows[0].balance_paise) : 0;
  if (bal < amountPaise) {
    throw ApiError.unprocessable(`Insufficient ${type} wallet balance`, {
      required_paise: amountPaise,
      available_paise: bal,
    });
  }
  const { rows: upd } = await client.query<{ balance_paise: string }>(
    'UPDATE sub_wallets SET balance_paise = balance_paise - $3 WHERE user_id = $1 AND wallet_type = $2 RETURNING balance_paise',
    [userId, type, amountPaise],
  );
  return Number(upd[0].balance_paise);
}

/** Both sub-wallet balances for a member (zero when the row is absent). */
export async function subBalances(userId: string) {
  const { rows } = await query<{ wallet_type: string; balance_paise: string }>(
    'SELECT wallet_type, balance_paise FROM sub_wallets WHERE user_id = $1',
    [userId],
  );
  const out = { settlement_paise: 0, commission_paise: 0 };
  for (const r of rows) {
    if (r.wallet_type === 'settlement') out.settlement_paise = Number(r.balance_paise);
    if (r.wallet_type === 'commission') out.commission_paise = Number(r.balance_paise);
  }
  return {
    settlement_paise: out.settlement_paise,
    settlement: paiseToRupees(String(out.settlement_paise)),
    commission_paise: out.commission_paise,
    commission: paiseToRupees(String(out.commission_paise)),
  };
}

export { bigintToNumber };
