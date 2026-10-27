import { query, withTransaction } from '../../../db';
import { ApiError } from '../../utils/ApiError';
import * as wallet from '../wallet/wallet.service';

/**
 * Connected Banking — link a corporate/current account (directly or via a
 * banking aggregator) to read its balance + statement, collect into virtual
 * accounts, and fund payouts from it.
 *
 * The 'manual' driver keeps the balance/statement admin-maintained; real
 * provider drivers (fetch balance/statement, open VAs, push payouts) plug in
 * behind the same service surface. Account numbers are stored masked only.
 */

/** Mask an account number to the last 4 digits. */
export function maskAccount(acct: string | null | undefined): string | null {
  if (!acct) return null;
  const digits = String(acct).replace(/\s+/g, '');
  if (digits.length <= 4) return digits;
  return 'X'.repeat(Math.max(2, digits.length - 4)) + digits.slice(-4);
}

export interface ConnectionInput {
  label: string;
  owner_user_id?: string | null;
  driver?: string;
  bank_name?: string | null;
  account_name?: string | null;
  account_number?: string | null; // masked on write; never stored in full
  ifsc?: string | null;
  extra?: Record<string, unknown>;
}

export async function listConnections() {
  const { rows } = await query(
    `SELECT c.*, u.full_name AS owner_name,
            (SELECT count(*) FROM virtual_accounts v WHERE v.connection_id = c.id) AS virtual_accounts
       FROM bank_connections c LEFT JOIN users u ON u.id = c.owner_user_id
      ORDER BY c.created_at DESC`,
  );
  return rows;
}

export async function getConnection(id: string) {
  const { rows } = await query('SELECT * FROM bank_connections WHERE id = $1', [id]);
  if (!rows[0]) throw ApiError.notFound('Bank connection not found');
  return rows[0];
}

export async function createConnection(input: ConnectionInput) {
  if (!input.label?.trim()) throw ApiError.badRequest('A label is required');
  const { rows } = await query(
    `INSERT INTO bank_connections
       (owner_user_id, label, driver, bank_name, account_name, account_number_masked, ifsc, extra)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      input.owner_user_id ?? null, input.label.trim(), input.driver || 'manual',
      input.bank_name ?? null, input.account_name ?? null, maskAccount(input.account_number),
      input.ifsc ?? null, JSON.stringify(input.extra ?? {}),
    ],
  );
  return rows[0];
}

export async function updateConnection(id: string, patch: Partial<ConnectionInput> & { status?: 'active' | 'disabled' }) {
  await getConnection(id);
  const { rows } = await query(
    `UPDATE bank_connections SET
        label        = COALESCE($2, label),
        driver       = COALESCE($3, driver),
        bank_name    = COALESCE($4, bank_name),
        account_name = COALESCE($5, account_name),
        account_number_masked = COALESCE($6, account_number_masked),
        ifsc         = COALESCE($7, ifsc),
        status       = COALESCE($8, status)
      WHERE id = $1 RETURNING *`,
    [
      id, patch.label ?? null, patch.driver ?? null, patch.bank_name ?? null, patch.account_name ?? null,
      patch.account_number ? maskAccount(patch.account_number) : null, patch.ifsc ?? null, patch.status ?? null,
    ],
  );
  return rows[0];
}

/**
 * Refresh the cached balance. The 'manual' driver takes the figure from the
 * caller (admin-entered); a real driver would call the bank API. Returns the
 * stored connection.
 */
export async function setBalance(id: string, balancePaise: number) {
  await getConnection(id);
  const { rows } = await query(
    'UPDATE bank_connections SET balance_paise = $2, balance_updated_at = now() WHERE id = $1 RETURNING *',
    [id, Math.round(balancePaise)],
  );
  return rows[0];
}

// ---- Virtual accounts (collections) ------------------------------------

export async function listVirtualAccounts(connectionId: string) {
  const { rows } = await query(
    `SELECT v.*, u.full_name AS user_name, u.phone AS user_phone
       FROM virtual_accounts v JOIN users u ON u.id = v.user_id
      WHERE v.connection_id = $1 ORDER BY v.created_at DESC`,
    [connectionId],
  );
  return rows;
}

export async function assignVirtualAccount(connectionId: string, userId: string, vaNumber: string, vaIfsc?: string, upiHandle?: string) {
  await getConnection(connectionId);
  try {
    const { rows } = await query(
      `INSERT INTO virtual_accounts (connection_id, user_id, va_number, va_ifsc, upi_handle)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [connectionId, userId, vaNumber.trim(), vaIfsc ?? null, upiHandle ?? null],
    );
    return rows[0];
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw ApiError.conflict('That virtual account number is already assigned');
    throw e;
  }
}

// ---- Statement ---------------------------------------------------------

export async function listStatement(connectionId: string, limit = 50) {
  const { rows } = await query(
    'SELECT * FROM bank_statement_entries WHERE connection_id = $1 ORDER BY txn_time DESC LIMIT $2',
    [connectionId, Math.min(limit, 500)],
  );
  return rows;
}

export interface StatementLine {
  direction: 'credit' | 'debit';
  amount_paise: number;
  txn_time?: string;
  balance_after_paise?: number | null;
  utr?: string | null;
  counterparty?: string | null;
  narration?: string | null;
  external_id?: string | null;
}

/** Append statement lines, skipping duplicates by (connection, external_id). Returns inserted count. */
export async function syncStatement(connectionId: string, lines: StatementLine[]): Promise<number> {
  await getConnection(connectionId);
  let inserted = 0;
  for (const l of lines) {
    const r = await query(
      `INSERT INTO bank_statement_entries
         (connection_id, txn_time, direction, amount_paise, balance_after_paise, utr, counterparty, narration, external_id)
       VALUES ($1, COALESCE($2, now()), $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (connection_id, external_id) DO NOTHING`,
      [connectionId, l.txn_time ?? null, l.direction, Math.round(l.amount_paise), l.balance_after_paise ?? null,
        l.utr ?? null, l.counterparty ?? null, l.narration ?? null, l.external_id ?? null],
    );
    inserted += r.rowCount ?? 0;
  }
  return inserted;
}

// ---- Collections → wallet auto-load ------------------------------------

export interface CollectionInput {
  amount_paise: number;
  external_id: string;        // bank/aggregator reference — idempotency key
  va_number?: string | null;  // target virtual account (resolves the member)
  user_id?: string | null;    // explicit member, if no VA
  utr?: string | null;
  payer?: string | null;
}

/**
 * Record an inbound bank credit and auto-load the resolved member's wallet.
 * Idempotent on (connection, external_id): a repeat delivery returns the
 * existing row without double-crediting. If no member can be resolved the
 * collection is stored 'received' (unapplied) for an admin to handle.
 */
export async function recordCollection(connectionId: string, input: CollectionInput) {
  await getConnection(connectionId);
  if (!input.external_id) throw ApiError.badRequest('external_id is required for idempotency');
  if (!(input.amount_paise > 0)) throw ApiError.badRequest('amount_paise must be positive');

  // Idempotency: already seen?
  const existing = await query<{ id: string; status: string; user_id: string | null }>(
    'SELECT id, status, user_id FROM bank_collections WHERE connection_id = $1 AND external_id = $2',
    [connectionId, input.external_id],
  );
  if (existing.rows[0]) return { ...existing.rows[0], duplicate: true };

  // Resolve the member from the VA (preferred) or an explicit user_id.
  let userId = input.user_id ?? null;
  let vaId: string | null = null;
  if (input.va_number) {
    const va = await query<{ id: string; user_id: string }>(
      "SELECT id, user_id FROM virtual_accounts WHERE connection_id = $1 AND va_number = $2 AND status = 'active'",
      [connectionId, input.va_number],
    );
    if (va.rows[0]) { vaId = va.rows[0].id; userId = va.rows[0].user_id; }
  }

  return withTransaction(async (client) => {
    const ins = await client.query<{ id: string }>(
      `INSERT INTO bank_collections (connection_id, virtual_account_id, user_id, amount_paise, utr, payer, external_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [connectionId, vaId, userId, Math.round(input.amount_paise), input.utr ?? null, input.payer ?? null,
        input.external_id, userId ? 'credited' : 'received'],
    );
    const collectionId = ins.rows[0].id;

    if (userId) {
      // Auto-load the member's wallet (balance + wallet_transactions ledger).
      await wallet.credit(client, {
        userId,
        amountPaise: Math.round(input.amount_paise),
        source: 'bank_collection',
        referenceId: collectionId,
        description: `Bank collection${input.utr ? ` UTR ${input.utr}` : ''}${input.payer ? ` from ${input.payer}` : ''}`,
      });
      await client.query('UPDATE bank_collections SET wallet_reference = $2 WHERE id = $1', [collectionId, collectionId]);
    }
    return { id: collectionId, status: userId ? 'credited' : 'received', user_id: userId, duplicate: false };
  });
}

/** Apply an unresolved 'received' collection to a member's wallet (admin action). */
export async function applyCollection(collectionId: string, userId: string) {
  const { rows } = await query<{ id: string; amount_paise: string; status: string; utr: string | null; payer: string | null }>(
    'SELECT id, amount_paise, status, utr, payer FROM bank_collections WHERE id = $1',
    [collectionId],
  );
  const c = rows[0];
  if (!c) throw ApiError.notFound('Collection not found');
  if (c.status !== 'received') throw ApiError.badRequest(`Collection is already ${c.status}`);

  return withTransaction(async (client) => {
    await wallet.credit(client, {
      userId,
      amountPaise: Number(c.amount_paise),
      source: 'bank_collection',
      referenceId: collectionId,
      description: `Bank collection${c.utr ? ` UTR ${c.utr}` : ''}${c.payer ? ` from ${c.payer}` : ''}`,
    });
    const upd = await client.query(
      "UPDATE bank_collections SET status='credited', user_id=$2, wallet_reference=$1 WHERE id=$1 AND status='received' RETURNING id",
      [collectionId, userId],
    );
    if (!upd.rows[0]) throw ApiError.conflict('Collection is no longer pending');
    return { id: collectionId, status: 'credited', user_id: userId };
  });
}

export async function listCollections(connectionId: string, limit = 50) {
  const { rows } = await query(
    `SELECT bc.*, u.full_name AS user_name FROM bank_collections bc
       LEFT JOIN users u ON u.id = bc.user_id
      WHERE bc.connection_id = $1 ORDER BY bc.created_at DESC LIMIT $2`,
    [connectionId, Math.min(limit, 500)],
  );
  return rows;
}
