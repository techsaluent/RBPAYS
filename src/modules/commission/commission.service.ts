import { PoolClient } from 'pg';
import { query } from '../../../db';
import { logger } from '../../config/logger';
import { credit } from '../wallet/wallet.service';

type Level = 'retailer' | 'distributor' | 'master_distributor' | 'admin';
const LEVELS: Level[] = ['retailer', 'distributor', 'master_distributor', 'admin'];

interface RuleRow {
  charge_type: string;
  charge_value: string;
  retailer_type: string;
  retailer_value: string;
  distributor_type: string;
  distributor_value: string;
  master_distributor_type: string;
  master_distributor_value: string;
  admin_type: string;
  admin_value: string;
}

interface ChainRow {
  id: string;
  role: string;
  depth: number;
}

/** Compute a commission/charge value in paise from a rule component. */
function valueToPaise(type: string, value: string, amountPaise: number): number {
  const v = Number(value);
  if (type === 'percent') return Math.round((amountPaise * v) / 100);
  return Math.round(v * 100); // flat rupees -> paise
}

/**
 * Resolve the commission plan + slab rule for a performer, service and amount.
 * Falls back to the default plan when the performer has none.
 */
async function resolveRule(
  performerId: string,
  serviceCode: string,
  amountPaise: number,
): Promise<RuleRow | null> {
  const { rows } = await query<RuleRow>(
    `SELECT r.*
       FROM commission_rules r
       JOIN commission_plans p ON p.id = r.plan_id
      WHERE r.service_code = $2
        AND $3 BETWEEN r.min_amount_paise AND r.max_amount_paise
        AND p.id = COALESCE(
              (SELECT commission_plan_id FROM users WHERE id = $1),
              (SELECT id FROM commission_plans WHERE is_default LIMIT 1))
      ORDER BY r.min_amount_paise DESC
      LIMIT 1`,
    [performerId, serviceCode, amountPaise],
  );
  return rows[0] ?? null;
}

/** Fetch the performer + ancestor chain (depth 0 = performer). */
async function ancestorChain(performerId: string): Promise<ChainRow[]> {
  const { rows } = await query<ChainRow>(
    `WITH RECURSIVE chain AS (
        SELECT id, role, parent_id, 0 AS depth FROM users WHERE id = $1
        UNION ALL
        SELECT u.id, u.role, u.parent_id, c.depth + 1
          FROM users u JOIN chain c ON u.id = c.parent_id
         WHERE c.depth < 10)
      SELECT id, role, depth FROM chain ORDER BY depth`,
    [performerId],
  );
  return rows;
}

/**
 * Distribute commission for a successful service transaction.
 *
 * Mapping (nearest wins):
 *   - retailer level           -> the performer (always earns the base)
 *   - distributor level        -> nearest ancestor with role 'distributor'
 *   - master_distributor level -> nearest ancestor with role 'master_distributor'
 *   - admin level              -> nearest ancestor 'admin', else the global admin
 *
 * Idempotent: commission_entries has UNIQUE(service_txn_id, level), and we skip
 * if entries already exist for this transaction. MUST run inside a DB txn.
 */
export async function distributeCommission(
  client: PoolClient,
  p: { performerId: string; serviceCode: string; amountPaise: number; txnId: string },
): Promise<void> {
  // Already distributed for this txn? (idempotency guard)
  const existing = await client.query(
    'SELECT 1 FROM commission_entries WHERE service_txn_id = $1 LIMIT 1',
    [p.txnId],
  );
  if (existing.rowCount) return;

  const rule = await resolveRule(p.performerId, p.serviceCode, p.amountPaise);
  if (!rule) {
    logger.debug({ ...p }, 'no commission rule matched; skipping distribution');
    return;
  }

  const chain = await ancestorChain(p.performerId);
  const nearestByRole = (role: string): string | undefined =>
    chain.find((c) => c.role === role)?.id;

  // Resolve a global admin if none is in the chain.
  let adminId = nearestByRole('admin');
  if (!adminId) {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1",
    );
    adminId = rows[0]?.id;
  }

  const beneficiaryFor: Record<Level, string | undefined> = {
    retailer: p.performerId,
    distributor: nearestByRole('distributor'),
    master_distributor: nearestByRole('master_distributor'),
    admin: adminId,
  };

  for (const level of LEVELS) {
    const beneficiary = beneficiaryFor[level];
    if (!beneficiary) continue;
    const type = rule[`${level}_type` as keyof RuleRow] as string;
    const value = rule[`${level}_value` as keyof RuleRow] as string;
    const amountPaise = valueToPaise(type, value, p.amountPaise);
    if (amountPaise <= 0) continue;

    // Record the entry (idempotent per level) then credit the wallet.
    const inserted = await client.query(
      `INSERT INTO commission_entries
         (service_txn_id, service_code, performer_id, beneficiary_id, level, amount_paise)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (service_txn_id, level) DO NOTHING`,
      [p.txnId, p.serviceCode, p.performerId, beneficiary, level, amountPaise],
    );
    if (inserted.rowCount === 1) {
      await credit(client, {
        userId: beneficiary,
        amountPaise,
        source: 'commission',
        referenceId: p.txnId,
        description: `${level} commission for ${p.serviceCode} (${p.txnId})`,
      });
    }
  }
}

/** A member's commission earnings summary + recent entries. */
export async function earningsFor(userId: string, limit = 20, offset = 0) {
  const totals = await query<{ total_paise: string; count: string }>(
    `SELECT COALESCE(SUM(amount_paise),0) AS total_paise, COUNT(*) AS count
       FROM commission_entries WHERE beneficiary_id = $1`,
    [userId],
  );
  const { rows } = await query(
    `SELECT id, service_txn_id, service_code, level, amount_paise, created_at
       FROM commission_entries
      WHERE beneficiary_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  return {
    total_paise: Number(totals.rows[0].total_paise),
    count: Number(totals.rows[0].count),
    items: rows.map((r) => ({ ...r, amount_paise: Number(r.amount_paise as string) })),
  };
}
