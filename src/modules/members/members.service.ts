import { query, withTransaction } from '../../../db';
import { ApiError } from '../../utils/ApiError';
import { hashPassword } from '../../utils/password';

export const ROLE_RANK: Record<string, number> = {
  user: 0,
  retailer: 1,
  distributor: 2,
  master_distributor: 3,
  admin: 4,
};

const PUBLIC_COLUMNS =
  'id, full_name, username, email, phone, role, status, kyc_status, parent_id, commission_plan_id, created_at';

export interface CreateMemberInput {
  parentId: string;
  parentRole: string;
  full_name: string;
  username?: string;
  email: string;
  phone: string;
  password: string;
  role: string;
  commission_plan_id?: string;
}

/**
 * Create a downline member under a parent. A parent may only create members of
 * a strictly lower rank. Provisions a wallet and activates all enabled services.
 */
export async function createMember(input: CreateMemberInput) {
  const parentRank = ROLE_RANK[input.parentRole] ?? 0;
  const childRank = ROLE_RANK[input.role];
  if (childRank === undefined) throw ApiError.badRequest(`Invalid role: ${input.role}`);
  if (childRank >= parentRank) {
    throw ApiError.forbidden(`A ${input.parentRole} cannot create a ${input.role}`);
  }

  const password_hash = await hashPassword(input.password);

  return withTransaction(async (client) => {
    const dupe = await client.query(
      `SELECT 1 FROM users
        WHERE lower(email) = lower($1) OR phone = $2
           OR ($3::text IS NOT NULL AND lower(username) = lower($3))
        LIMIT 1`,
      [input.email, input.phone, input.username ?? null],
    );
    if (dupe.rowCount) throw ApiError.conflict('A user with this email, phone or username already exists');

    // Default commission plan when none specified.
    const planId =
      input.commission_plan_id ??
      (await client.query<{ id: string }>('SELECT id FROM commission_plans WHERE is_default LIMIT 1'))
        .rows[0]?.id ??
      null;

    const { rows } = await client.query(
      `INSERT INTO users (full_name, username, email, phone, password_hash, role, parent_id, commission_plan_id, activated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       RETURNING ${PUBLIC_COLUMNS}`,
      [input.full_name, input.username ?? null, input.email, input.phone, password_hash, input.role, input.parentId, planId],
    );
    const member = rows[0];

    await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [member.id]);

    // Activate all globally-enabled services for the new member.
    await client.query(
      `INSERT INTO user_services (user_id, service_code)
       SELECT $1, code FROM services WHERE enabled = true
       ON CONFLICT DO NOTHING`,
      [member.id],
    );

    return member;
  });
}

/** Direct children of a member (optionally filtered by role). */
export async function listDownline(parentId: string, role?: string) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM users
      WHERE parent_id = $1 AND ($2::text IS NULL OR role = $2)
      ORDER BY created_at DESC`,
    [parentId, role ?? null],
  );
  return rows;
}

/** Full downline tree (all descendants) with depth, capped for safety. */
export async function downlineTree(rootId: string) {
  const { rows } = await query(
    `WITH RECURSIVE tree AS (
        SELECT id, full_name, role, parent_id, status, 1 AS depth
          FROM users WHERE parent_id = $1
        UNION ALL
        SELECT u.id, u.full_name, u.role, u.parent_id, u.status, t.depth + 1
          FROM users u JOIN tree t ON u.parent_id = t.id
         WHERE t.depth < 10)
      SELECT id, full_name, role, parent_id, status, depth FROM tree
      ORDER BY depth, full_name`,
    [rootId],
  );
  return rows;
}

/** Counts of direct downline by role, for panel dashboards. */
export async function downlineCounts(parentId: string) {
  const { rows } = await query<{ role: string; n: string }>(
    'SELECT role, COUNT(*) AS n FROM users WHERE parent_id = $1 GROUP BY role',
    [parentId],
  );
  return Object.fromEntries(rows.map((r) => [r.role, Number(r.n)]));
}
