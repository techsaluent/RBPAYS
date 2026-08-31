import { query } from '../../../db';

export interface DevRequestInput {
  kind: 'feature' | 'bug' | 'ui';
  title: string;
  description?: string;
  area?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
}

export async function createDevRequest(userId: string | null, input: DevRequestInput): Promise<Record<string, unknown>> {
  const { rows } = await query(
    `INSERT INTO dev_requests (kind, title, description, area, priority, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.kind, input.title, input.description ?? '', input.area ?? null, input.priority ?? 'normal', userId],
  );
  return rows[0];
}

export async function listDevRequests(filter: { status?: string; kind?: string; limit?: number }): Promise<Record<string, unknown>[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status) { params.push(filter.status); where.push(`status = $${params.length}`); }
  if (filter.kind) { params.push(filter.kind); where.push(`kind = $${params.length}`); }
  params.push(Math.min(filter.limit ?? 100, 200));
  const { rows } = await query(
    `SELECT dr.*, u.full_name AS created_by_name
       FROM dev_requests dr LEFT JOIN users u ON u.id = dr.created_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function getDevRequest(id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await query('SELECT * FROM dev_requests WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function setPlan(id: string, plan: unknown): Promise<Record<string, unknown> | null> {
  const { rows } = await query(
    `UPDATE dev_requests SET ai_plan = $2, status = CASE WHEN status = 'new' THEN 'triaged' ELSE status END, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(plan)],
  );
  return rows[0] ?? null;
}

/** Move a request through the workflow (approve / reject / dispatched / done). */
export async function setStatus(id: string, status: string, remark?: string): Promise<Record<string, unknown> | null> {
  const { rows } = await query(
    `UPDATE dev_requests SET status = $2, remark = COALESCE($3, remark), updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status, remark ?? null],
  );
  return rows[0] ?? null;
}
