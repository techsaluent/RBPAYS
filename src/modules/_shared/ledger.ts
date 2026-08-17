import { PoolClient } from 'pg';
import { ApiError } from '../../utils/ApiError';

/**
 * Double-entry ledger posting.
 *
 * Every financial movement is recorded as a balanced journal entry:
 * the sum of debit lines must equal the sum of credit lines. The DB also
 * enforces this via a deferred constraint trigger, but we validate in the
 * app first for a clear error.
 *
 * Account codes come from `chart_of_accounts`. For per-member liability
 * accounts (member_wallet / settlement_wallet / commission_wallet) pass
 * `walletUserId` to identify whose wallet the line belongs to.
 *
 * MUST run inside withTransaction (shares the client) so the journal
 * commits atomically with the wallet balance mutations it mirrors.
 */
export interface JournalLine {
  account: string;
  direction: 'debit' | 'credit';
  amountPaise: number;
  walletUserId?: string;
  narration?: string;
}

export interface JournalInput {
  source: string;
  reference?: string;
  narration?: string;
  lines: JournalLine[];
}

export async function postJournal(client: PoolClient, entry: JournalInput): Promise<string> {
  if (!entry.lines || entry.lines.length < 2) {
    throw ApiError.internal('Journal entry needs at least two lines');
  }
  let debits = 0;
  let credits = 0;
  for (const l of entry.lines) {
    if (!Number.isInteger(l.amountPaise) || l.amountPaise <= 0) {
      throw ApiError.internal('Journal line amount must be a positive integer (paise)');
    }
    if (l.direction === 'debit') debits += l.amountPaise;
    else credits += l.amountPaise;
  }
  if (debits !== credits) {
    throw ApiError.internal(`Unbalanced journal entry: debits ${debits} <> credits ${credits}`);
  }

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries (reference, source, narration)
     VALUES ($1,$2,$3) RETURNING id`,
    [entry.reference ?? null, entry.source, entry.narration ?? null],
  );
  const entryId = rows[0].id;

  for (const l of entry.lines) {
    await client.query(
      `INSERT INTO journal_lines
         (entry_id, account_code, wallet_user_id, direction, amount_paise, narration)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [entryId, l.account, l.walletUserId ?? null, l.direction, l.amountPaise, l.narration ?? null],
    );
  }
  return entryId;
}
