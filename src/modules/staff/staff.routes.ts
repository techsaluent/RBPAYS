import { Request, Response, Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { requireAuth, requireRole, hashApiKey, API_KEY_PREFIX } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query, withTransaction } from '../../../db';
import { hashPassword } from '../../utils/password';
import { PERMISSIONS, PERMISSION_KEYS, PRESETS } from './permissions';
import { logAudit } from '../audit/audit.service';

/** Mint a fresh staff API key (raw shown once) and store only its hash. */
async function issueApiKey(client: import('pg').PoolClient, userId: string, label = 'default'): Promise<string> {
  const raw = API_KEY_PREFIX + crypto.randomBytes(24).toString('hex');
  await client.query('INSERT INTO staff_api_tokens (user_id, token_hash, label) VALUES ($1,$2,$3)', [
    userId,
    hashApiKey(raw),
    label,
  ]);
  return raw;
}

// Only the super admin manages staff accounts and their powers.
const router = Router();
router.use(requireAuth, requireRole('admin'));

const permissionArray = z.array(z.enum(PERMISSION_KEYS as [string, ...string[]])).default([]);

const createSchema = z
  .object({
    full_name: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email(),
    phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile'),
    kind: z.enum(['human', 'ai']).default('human'),
    // Human staff sign in with a password; AI agents use an issued API key.
    password: z.string().min(8).max(128).optional(),
    preset: z.enum(Object.keys(PRESETS) as [string, ...string[]]).optional(),
    permissions: permissionArray.optional(),
  })
  .refine((v) => v.kind === 'ai' || (v.password && v.password.length >= 8), {
    message: 'A password (min 8 chars) is required for human staff',
    path: ['password'],
  });

const updateSchema = z.object({
  permissions: permissionArray,
});

/** Resolve the starting permission set from an explicit list and/or a preset. */
function resolvePermissions(explicit?: string[], preset?: string): string[] {
  const set = new Set<string>(explicit ?? []);
  if (preset && PRESETS[preset]) PRESETS[preset].permissions.forEach((p) => set.add(p));
  return [...set];
}

async function setPermissions(
  client: import('pg').PoolClient,
  userId: string,
  permissions: string[],
  grantedBy: string,
): Promise<void> {
  await client.query('DELETE FROM staff_permissions WHERE user_id = $1', [userId]);
  for (const p of permissions) {
    await client.query(
      'INSERT INTO staff_permissions (user_id, permission, granted_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [userId, p, grantedBy],
    );
  }
}

// The permission catalog + presets (for the management UI).
router.get(
  '/catalog',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ permissions: PERMISSIONS, presets: PRESETS });
  }),
);

// List staff members with their granted permissions.
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query<{ id: string; full_name: string; email: string; phone: string; status: string; staff_kind: string | null; created_at: string; active_tokens: string }>(
      `SELECT u.id, u.full_name, u.email, u.phone, u.status, u.staff_kind, u.created_at,
              COUNT(t.id) FILTER (WHERE t.revoked_at IS NULL) AS active_tokens
         FROM users u
         LEFT JOIN staff_api_tokens t ON t.user_id = u.id
        WHERE u.role = 'staff'
        GROUP BY u.id ORDER BY u.created_at DESC`,
    );
    const perms = await query<{ user_id: string; permission: string }>(
      `SELECT sp.user_id, sp.permission FROM staff_permissions sp
         JOIN users u ON u.id = sp.user_id AND u.role = 'staff'`,
    );
    const byUser: Record<string, string[]> = {};
    for (const p of perms.rows) (byUser[p.user_id] ??= []).push(p.permission);
    res.json({ items: rows.map((r) => ({
      ...r,
      kind: r.staff_kind ?? 'human',
      active_tokens: Number(r.active_tokens),
      permissions: byUser[r.id] ?? [],
    })) });
  }),
);

// Create a staff member.
router.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof createSchema>;
    const permissions = resolvePermissions(b.permissions, b.preset);
    // AI agents don't log in interactively; give them an unusable random password.
    const password_hash = await hashPassword(b.password ?? crypto.randomBytes(24).toString('hex'));

    const result = await withTransaction(async (client) => {
      const dupe = await client.query('SELECT 1 FROM users WHERE lower(email) = lower($1) OR phone = $2 LIMIT 1', [
        b.email,
        b.phone,
      ]);
      if (dupe.rowCount) throw ApiError.conflict('A user with this email or phone already exists');

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (full_name, email, phone, password_hash, role, status, kyc_status, staff_kind, activated_at)
         VALUES ($1,$2,$3,$4,'staff','active','verified',$5, now()) RETURNING id`,
        [b.full_name, b.email, b.phone, password_hash, b.kind],
      );
      const id = rows[0].id;
      await setPermissions(client, id, permissions, req.user!.id);
      // AI agents get an API key so they can authenticate as this staff account.
      const apiKey = b.kind === 'ai' ? await issueApiKey(client, id) : undefined;
      return { staff: { id, full_name: b.full_name, email: b.email, phone: b.phone, status: 'active', kind: b.kind, permissions }, apiKey };
    });

    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'staff.create',
      targetType: 'staff', targetId: result.staff.id, detail: { email: b.email, kind: b.kind, permissions } });
    // api_key is returned ONCE (only its hash is stored) for AI agents.
    res.status(201).json({ staff: result.staff, api_key: result.apiKey });
  }),
);

// Replace a staff member's permissions.
router.patch(
  '/:id',
  validate(updateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof updateSchema>;
    const target = await query<{ id: string }>("SELECT id FROM users WHERE id = $1 AND role = 'staff'", [req.params.id]);
    if (!target.rows[0]) throw ApiError.notFound('Staff member not found');
    await withTransaction((client) => setPermissions(client, req.params.id, b.permissions, req.user!.id));
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'staff.permissions',
      targetType: 'staff', targetId: req.params.id, detail: { permissions: b.permissions } });
    res.json({ id: req.params.id, permissions: b.permissions });
  }),
);

// Activate / suspend a staff member.
router.post(
  '/:id/status',
  validate(z.object({ status: z.enum(['active', 'suspended']) })),
  asyncHandler(async (req: Request, res: Response) => {
    const { rows } = await query(
      "UPDATE users SET status = $1 WHERE id = $2 AND role = 'staff' RETURNING id, status",
      [req.body.status, req.params.id],
    );
    if (!rows[0]) throw ApiError.notFound('Staff member not found');
    if (req.user) await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'staff.status',
      targetType: 'staff', targetId: req.params.id, detail: { status: req.body.status } });
    res.json({ staff: rows[0] });
  }),
);

// (Re)issue an API key for an AI-agent staff member — revokes existing keys and
// returns a fresh one ONCE.
router.post(
  '/:id/token',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const target = await query<{ id: string; staff_kind: string | null }>(
      "SELECT id, staff_kind FROM users WHERE id = $1 AND role = 'staff'",
      [req.params.id],
    );
    if (!target.rows[0]) throw ApiError.notFound('Staff member not found');
    const apiKey = await withTransaction(async (client) => {
      await client.query("UPDATE staff_api_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [req.params.id]);
      // Ensure the account is flagged as an AI agent once it has a key.
      await client.query("UPDATE users SET staff_kind = 'ai' WHERE id = $1", [req.params.id]);
      return issueApiKey(client, req.params.id);
    });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'staff.token.issue',
      targetType: 'staff', targetId: req.params.id, detail: {} });
    res.json({ api_key: apiKey });
  }),
);

// Revoke all API keys for a staff member (stops the AI agent immediately).
router.post(
  '/:id/token/revoke',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rowCount } = await query(
      "UPDATE staff_api_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
      [req.params.id],
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'staff.token.revoke',
      targetType: 'staff', targetId: req.params.id, detail: { revoked: rowCount } });
    res.json({ revoked: rowCount });
  }),
);

export default router;
