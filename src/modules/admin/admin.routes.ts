import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query, withTransaction } from '../../../db';
import { rupeesToPaise } from '../../utils/money';
import { debit } from '../wallet/wallet.service';
import { createMember } from '../members/members.service';
import { usernameSchema } from '../auth/auth.schemas';
import { dashboardStats } from './admin.dashboard';

const router = Router();
router.use(requireAuth, requireRole('admin'));

const USER_COLUMNS =
  'id, full_name, username, email, phone, role, status, kyc_status, parent_id, commission_plan_id, activated_at, created_at';

// ---------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------
router.get(
  '/dashboard',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await dashboardStats());
  }),
);

// ---------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------
const listUsersSchema = z.object({
  role: z.enum(['user', 'retailer', 'distributor', 'master_distributor', 'admin', 'agent']).optional(),
  status: z.enum(['active', 'suspended', 'blocked']).optional(),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get(
  '/users',
  validate(listUsersSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof listUsersSchema>;
    const like = q.q ? `%${q.q}%` : null;
    const { rows } = await query(
      `SELECT ${USER_COLUMNS} FROM users
        WHERE ($1::text IS NULL OR role = $1)
          AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR full_name ILIKE $3 OR email ILIKE $3 OR phone ILIKE $3 OR username ILIKE $3)
        ORDER BY created_at DESC
        LIMIT $4 OFFSET $5`,
      [q.role ?? null, q.status ?? null, like, q.limit, q.offset],
    );
    res.json({ items: rows, limit: q.limit, offset: q.offset });
  }),
);

router.get(
  '/users/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const user = await query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [req.params.id]);
    if (!user.rows[0]) throw ApiError.notFound('User not found');
    const [wallet, services] = await Promise.all([
      query('SELECT balance_paise, currency FROM wallets WHERE user_id = $1', [req.params.id]),
      query('SELECT service_code, active, activated_at FROM user_services WHERE user_id = $1', [req.params.id]),
    ]);
    res.json({ user: user.rows[0], wallet: wallet.rows[0] ?? null, services: services.rows });
  }),
);

const createUserSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  username: usernameSchema.optional(),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
  password: z.string().min(8).max(128),
  role: z.enum(['retailer', 'distributor', 'master_distributor']),
  commission_plan_id: z.string().uuid().optional(),
});

// Admin onboards a member (admin is the parent; any member role allowed).
router.post(
  '/users',
  validate(createUserSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof createUserSchema>;
    const member = await createMember({ parentId: req.user.id, parentRole: 'admin', ...b });
    res.status(201).json({ member });
  }),
);

const statusSchema = z.object({ status: z.enum(['active', 'suspended', 'blocked']) });

// Activate / suspend / block an account.
router.patch(
  '/users/:id/status',
  validate(statusSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { status } = req.body as z.infer<typeof statusSchema>;
    const { rows } = await query(
      `UPDATE users
          SET status = $1, activated_at = CASE WHEN $1 = 'active' AND activated_at IS NULL THEN now() ELSE activated_at END
        WHERE id = $2 RETURNING ${USER_COLUMNS}`,
      [status, req.params.id],
    );
    if (!rows[0]) throw ApiError.notFound('User not found');
    res.json({ user: rows[0] });
  }),
);

const planSchema = z.object({ commission_plan_id: z.string().uuid().nullable() });

// Assign a commission plan to a user.
router.patch(
  '/users/:id/plan',
  validate(planSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { commission_plan_id } = req.body as z.infer<typeof planSchema>;
    const { rows } = await query(
      `UPDATE users SET commission_plan_id = $1 WHERE id = $2 RETURNING ${USER_COLUMNS}`,
      [commission_plan_id, req.params.id],
    );
    if (!rows[0]) throw ApiError.notFound('User not found');
    res.json({ user: rows[0] });
  }),
);

const userServiceSchema = z.object({
  service_code: z.string().trim().min(1).max(40),
  active: z.boolean().default(true),
  // If activating and the service has an activation charge, debit the wallet.
  apply_activation_fee: z.boolean().default(false),
});

// Activate / deactivate a service for a user (optionally charging the fee).
router.post(
  '/users/:id/services',
  validate(userServiceSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof userServiceSchema>;
    const userId = req.params.id;

    const result = await withTransaction(async (client) => {
      const svc = await client.query<{ activation_charge_paise: string; enabled: boolean }>(
        'SELECT activation_charge_paise, enabled FROM services WHERE code = $1',
        [b.service_code],
      );
      if (!svc.rows[0]) throw ApiError.notFound('Service not found');

      const userExists = await client.query('SELECT 1 FROM users WHERE id = $1', [userId]);
      if (!userExists.rowCount) throw ApiError.notFound('User not found');

      const { rows } = await client.query(
        `INSERT INTO user_services (user_id, service_code, active)
         VALUES ($1,$2,$3)
         ON CONFLICT (user_id, service_code) DO UPDATE SET active = EXCLUDED.active
         RETURNING *`,
        [userId, b.service_code, b.active],
      );

      let charged = 0;
      const fee = Number(svc.rows[0].activation_charge_paise);
      if (b.active && b.apply_activation_fee && fee > 0) {
        await debit(client, {
          userId,
          amountPaise: fee,
          source: 'activation_fee',
          description: `Activation fee for ${b.service_code}`,
        });
        charged = fee;
      }
      return { user_service: rows[0], charged_paise: charged };
    });

    res.json(result);
  }),
);

// ---------------------------------------------------------------------
// Services catalogue
// ---------------------------------------------------------------------
router.get(
  '/services',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query('SELECT * FROM services ORDER BY code');
    res.json({ items: rows });
  }),
);

const serviceUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  activation_charge: z.coerce.number().min(0).optional(), // rupees
});

router.patch(
  '/services/:code',
  validate(serviceUpdateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof serviceUpdateSchema>;
    const { rows } = await query(
      `UPDATE services
          SET enabled = COALESCE($1, enabled),
              activation_charge_paise = COALESCE($2, activation_charge_paise)
        WHERE code = $3 RETURNING *`,
      [
        b.enabled ?? null,
        b.activation_charge === undefined ? null : rupeesToPaise(b.activation_charge),
        req.params.code,
      ],
    );
    if (!rows[0]) throw ApiError.notFound('Service not found');
    res.json({ service: rows[0] });
  }),
);

// ---------------------------------------------------------------------
// Commission plans + rules
// ---------------------------------------------------------------------
router.get(
  '/commission-plans',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query('SELECT * FROM commission_plans ORDER BY created_at');
    res.json({ items: rows });
  }),
);

const planCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional(),
  is_default: z.boolean().default(false),
});

router.post(
  '/commission-plans',
  validate(planCreateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof planCreateSchema>;
    const plan = await withTransaction(async (client) => {
      if (b.is_default) {
        await client.query('UPDATE commission_plans SET is_default = false WHERE is_default = true');
      }
      const { rows } = await client.query(
        'INSERT INTO commission_plans (name, description, is_default) VALUES ($1,$2,$3) RETURNING *',
        [b.name, b.description ?? null, b.is_default],
      );
      return rows[0];
    });
    res.status(201).json({ plan });
  }),
);

router.get(
  '/commission-plans/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const plan = await query('SELECT * FROM commission_plans WHERE id = $1', [req.params.id]);
    if (!plan.rows[0]) throw ApiError.notFound('Plan not found');
    const rules = await query(
      'SELECT * FROM commission_rules WHERE plan_id = $1 ORDER BY service_code, min_amount_paise',
      [req.params.id],
    );
    res.json({ plan: plan.rows[0], rules: rules.rows });
  }),
);

const cvType = z.enum(['flat', 'percent']);
const ruleSchema = z.object({
  service_code: z.string().trim().min(1).max(40),
  min_amount: z.coerce.number().min(0).default(0), // rupees
  max_amount: z.coerce.number().min(0).optional(), // rupees; omit = no upper bound
  charge_type: cvType.default('flat'),
  charge_value: z.coerce.number().min(0).default(0),
  retailer_type: cvType.default('flat'),
  retailer_value: z.coerce.number().min(0).default(0),
  distributor_type: cvType.default('flat'),
  distributor_value: z.coerce.number().min(0).default(0),
  master_distributor_type: cvType.default('flat'),
  master_distributor_value: z.coerce.number().min(0).default(0),
  admin_type: cvType.default('flat'),
  admin_value: z.coerce.number().min(0).default(0),
});

const MAX_BIGINT = '9223372036854775807';

// Add a slab rule to a plan.
router.post(
  '/commission-plans/:id/rules',
  validate(ruleSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof ruleSchema>;
    const plan = await query('SELECT 1 FROM commission_plans WHERE id = $1', [req.params.id]);
    if (!plan.rowCount) throw ApiError.notFound('Plan not found');
    const { rows } = await query(
      `INSERT INTO commission_rules
         (plan_id, service_code, min_amount_paise, max_amount_paise,
          charge_type, charge_value,
          retailer_type, retailer_value, distributor_type, distributor_value,
          master_distributor_type, master_distributor_value, admin_type, admin_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        req.params.id,
        b.service_code,
        rupeesToPaise(b.min_amount),
        b.max_amount === undefined ? MAX_BIGINT : rupeesToPaise(b.max_amount),
        b.charge_type, b.charge_value,
        b.retailer_type, b.retailer_value,
        b.distributor_type, b.distributor_value,
        b.master_distributor_type, b.master_distributor_value,
        b.admin_type, b.admin_value,
      ],
    );
    res.status(201).json({ rule: rows[0] });
  }),
);

router.delete(
  '/commission-plans/:id/rules/:ruleId',
  asyncHandler(async (req: Request, res: Response) => {
    const { rowCount } = await query(
      'DELETE FROM commission_rules WHERE id = $1 AND plan_id = $2',
      [req.params.ruleId, req.params.id],
    );
    if (!rowCount) throw ApiError.notFound('Rule not found');
    res.status(204).send();
  }),
);

export default router;
