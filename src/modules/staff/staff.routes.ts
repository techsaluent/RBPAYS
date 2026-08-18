import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query, withTransaction } from '../../../db';
import { hashPassword } from '../../utils/password';
import { PERMISSIONS, PERMISSION_KEYS, PRESETS } from './permissions';

// Only the super admin manages staff accounts and their powers.
const router = Router();
router.use(requireAuth, requireRole('admin'));

const permissionArray = z.array(z.enum(PERMISSION_KEYS as [string, ...string[]])).default([]);

const createSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile'),
  password: z.string().min(8).max(128),
  preset: z.enum(Object.keys(PRESETS) as [string, ...string[]]).optional(),
  permissions: permissionArray.optional(),
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
    const { rows } = await query<{ id: string; full_name: string; email: string; phone: string; status: string; created_at: string }>(
      `SELECT id, full_name, email, phone, status, created_at FROM users WHERE role = 'staff' ORDER BY created_at DESC`,
    );
    const perms = await query<{ user_id: string; permission: string }>(
      `SELECT sp.user_id, sp.permission FROM staff_permissions sp
         JOIN users u ON u.id = sp.user_id AND u.role = 'staff'`,
    );
    const byUser: Record<string, string[]> = {};
    for (const p of perms.rows) (byUser[p.user_id] ??= []).push(p.permission);
    res.json({ items: rows.map((r) => ({ ...r, permissions: byUser[r.id] ?? [] })) });
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
    const password_hash = await hashPassword(b.password);

    const staff = await withTransaction(async (client) => {
      const dupe = await client.query('SELECT 1 FROM users WHERE lower(email) = lower($1) OR phone = $2 LIMIT 1', [
        b.email,
        b.phone,
      ]);
      if (dupe.rowCount) throw ApiError.conflict('A user with this email or phone already exists');

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (full_name, email, phone, password_hash, role, status, kyc_status, activated_at)
         VALUES ($1,$2,$3,$4,'staff','active','verified', now()) RETURNING id`,
        [b.full_name, b.email, b.phone, password_hash],
      );
      const id = rows[0].id;
      await setPermissions(client, id, permissions, req.user!.id);
      return { id, full_name: b.full_name, email: b.email, phone: b.phone, status: 'active', permissions };
    });

    res.status(201).json({ staff });
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
    res.json({ staff: rows[0] });
  }),
);

export default router;
