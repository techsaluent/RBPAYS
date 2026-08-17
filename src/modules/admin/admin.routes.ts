import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query, withTransaction } from '../../../db';
import { rupeesToPaise, bigintToNumber, paiseToRupees } from '../../utils/money';
import { debit, credit } from '../wallet/wallet.service';
import { createMember } from '../members/members.service';
import { usernameSchema } from '../auth/auth.schemas';
import { dashboardStats } from './admin.dashboard';
import { refreshProviderRegistry } from '../../providers/registry';

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
  min_commission: z.coerce.number().min(0).optional(),    // rupees — floor per txn
  max_commission: z.coerce.number().min(0).optional(),    // rupees — ceiling per txn
});

router.patch(
  '/services/:code',
  validate(serviceUpdateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof serviceUpdateSchema>;
    if (
      b.min_commission !== undefined &&
      b.max_commission !== undefined &&
      b.min_commission > b.max_commission
    ) {
      throw ApiError.badRequest('min_commission cannot exceed max_commission');
    }
    const { rows } = await query(
      `UPDATE services
          SET enabled = COALESCE($1, enabled),
              activation_charge_paise = COALESCE($2, activation_charge_paise),
              min_commission_paise = COALESCE($3, min_commission_paise),
              max_commission_paise = COALESCE($4, max_commission_paise)
        WHERE code = $5 RETURNING *`,
      [
        b.enabled ?? null,
        b.activation_charge === undefined ? null : rupeesToPaise(b.activation_charge),
        b.min_commission === undefined ? null : rupeesToPaise(b.min_commission),
        b.max_commission === undefined ? null : rupeesToPaise(b.max_commission),
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

    // Enforce the super-admin's per-service commission guardrails. When every
    // level is a flat amount, the total distributed commission is fixed and
    // must fall within [min_commission, max_commission] for the service.
    const svc = await query<{ min_commission_paise: string; max_commission_paise: string }>(
      'SELECT min_commission_paise, max_commission_paise FROM services WHERE code = $1',
      [b.service_code],
    );
    if (!svc.rows[0]) throw ApiError.notFound('Service not found');
    const allFlat =
      b.retailer_type === 'flat' &&
      b.distributor_type === 'flat' &&
      b.master_distributor_type === 'flat' &&
      b.admin_type === 'flat';
    if (allFlat) {
      const totalPaise =
        rupeesToPaise(b.retailer_value) +
        rupeesToPaise(b.distributor_value) +
        rupeesToPaise(b.master_distributor_value) +
        rupeesToPaise(b.admin_value);
      const min = Number(svc.rows[0].min_commission_paise);
      const max = Number(svc.rows[0].max_commission_paise);
      if (totalPaise < min || totalPaise > max) {
        throw ApiError.unprocessable(
          `Total commission ₹${(totalPaise / 100).toLocaleString('en-IN')} is outside the allowed range ` +
            `₹${(min / 100).toLocaleString('en-IN')}–₹${(max / 100).toLocaleString('en-IN')} for ${b.service_code}`,
        );
      }
    }
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

// ---------------------------------------------------------------------
// Company bank accounts (for cash / bank deposit top-ups)
// ---------------------------------------------------------------------
router.get(
  '/bank-accounts',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query('SELECT * FROM company_bank_accounts ORDER BY sort_order, created_at');
    res.json({ items: rows });
  }),
);

const bankSchema = z.object({
  label: z.string().trim().min(2).max(120),
  bank_name: z.string().trim().min(2).max(120),
  account_name: z.string().trim().min(2).max(120),
  account_number: z.string().trim().regex(/^\d{6,20}$/, 'Invalid account number'),
  ifsc: z.string().trim().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC'),
  branch: z.string().trim().max(120).optional(),
  upi_id: z.string().trim().max(120).optional(),
  instructions: z.string().trim().max(500).optional(),
  is_active: z.boolean().default(true),
  sort_order: z.coerce.number().int().default(0),
});

router.post(
  '/bank-accounts',
  validate(bankSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof bankSchema>;
    const { rows } = await query(
      `INSERT INTO company_bank_accounts
         (label, bank_name, account_name, account_number, ifsc, branch, upi_id, instructions, is_active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [b.label, b.bank_name, b.account_name, b.account_number, b.ifsc,
       b.branch ?? null, b.upi_id ?? null, b.instructions ?? null, b.is_active, b.sort_order],
    );
    res.status(201).json({ bank_account: rows[0] });
  }),
);

const bankUpdateSchema = bankSchema.partial();

router.patch(
  '/bank-accounts/:id',
  validate(bankUpdateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof bankUpdateSchema>;
    const { rows } = await query(
      `UPDATE company_bank_accounts SET
          label = COALESCE($1,label), bank_name = COALESCE($2,bank_name),
          account_name = COALESCE($3,account_name), account_number = COALESCE($4,account_number),
          ifsc = COALESCE($5,ifsc), branch = COALESCE($6,branch), upi_id = COALESCE($7,upi_id),
          instructions = COALESCE($8,instructions), is_active = COALESCE($9,is_active),
          sort_order = COALESCE($10,sort_order)
        WHERE id = $11 RETURNING *`,
      [b.label ?? null, b.bank_name ?? null, b.account_name ?? null, b.account_number ?? null,
       b.ifsc ?? null, b.branch ?? null, b.upi_id ?? null, b.instructions ?? null,
       b.is_active ?? null, b.sort_order ?? null, req.params.id],
    );
    if (!rows[0]) throw ApiError.notFound('Bank account not found');
    res.json({ bank_account: rows[0] });
  }),
);

router.delete(
  '/bank-accounts/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { rowCount } = await query('DELETE FROM company_bank_accounts WHERE id = $1', [req.params.id]);
    if (!rowCount) throw ApiError.notFound('Bank account not found');
    res.status(204).send();
  }),
);

// ---------------------------------------------------------------------
// Wallet top-up requests — review queue
// ---------------------------------------------------------------------
const topupListSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get(
  '/topups',
  validate(topupListSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof topupListSchema>;
    const { rows } = await query(
      `SELECT t.id, t.user_id, u.full_name, u.username, u.role,
              t.amount_paise, t.method, t.bank_account_id, t.reference, t.proof_url, t.note,
              t.status, t.remarks, t.reviewed_at, t.created_at
         FROM wallet_topup_requests t
         JOIN users u ON u.id = t.user_id
        WHERE t.status = $1
        ORDER BY t.created_at DESC
        LIMIT $2 OFFSET $3`,
      [q.status, q.limit, q.offset],
    );
    res.json({
      items: rows.map((r) => ({
        ...r,
        amount_paise: bigintToNumber(r.amount_paise as string),
        amount: paiseToRupees(r.amount_paise as string),
      })),
      limit: q.limit,
      offset: q.offset,
    });
  }),
);

const reviewSchema = z.object({ remarks: z.string().trim().max(300).optional() });

// Approve a top-up: credits the member's wallet and marks it approved.
router.post(
  '/topups/:id/approve',
  validate(reviewSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { remarks } = req.body as z.infer<typeof reviewSchema>;
    const adminId = req.user.id;
    const topupId = req.params.id;

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{ user_id: string; amount_paise: string; status: string }>(
        'SELECT user_id, amount_paise, status FROM wallet_topup_requests WHERE id = $1 FOR UPDATE',
        [topupId],
      );
      const t = rows[0];
      if (!t) throw ApiError.notFound('Top-up request not found');
      if (t.status !== 'pending') throw ApiError.conflict(`Top-up already ${t.status}`);

      await credit(client, {
        userId: t.user_id,
        amountPaise: Number(t.amount_paise),
        source: 'topup',
        referenceId: topupId,
        description: 'Wallet top-up (approved)',
      });
      const txn = await client.query<{ id: string }>(
        `SELECT id FROM wallet_transactions
          WHERE reference_id = $1 AND source = 'topup' ORDER BY created_at DESC LIMIT 1`,
        [topupId],
      );
      const upd = await client.query(
        `UPDATE wallet_topup_requests
            SET status = 'approved', reviewed_by = $1, reviewed_at = now(),
                remarks = $2, wallet_txn_id = $3
          WHERE id = $4 RETURNING id, user_id, amount_paise, status, reviewed_at`,
        [adminId, remarks ?? null, txn.rows[0]?.id ?? null, topupId],
      );
      return upd.rows[0];
    });

    res.json({ request: result });
  }),
);

// Reject a top-up (no wallet change).
router.post(
  '/topups/:id/reject',
  validate(reviewSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { remarks } = req.body as z.infer<typeof reviewSchema>;
    const { rows } = await query(
      `UPDATE wallet_topup_requests
          SET status = 'rejected', reviewed_by = $1, reviewed_at = now(), remarks = $2
        WHERE id = $3 AND status = 'pending'
        RETURNING id, status, reviewed_at`,
      [req.user.id, remarks ?? null, req.params.id],
    );
    if (!rows[0]) throw ApiError.conflict('Top-up not found or already reviewed');
    res.json({ request: rows[0] });
  }),
);

// ---------------------------------------------------------------------
// Service providers — multiple per service, one active (routing target)
// ---------------------------------------------------------------------
router.get(
  '/services/:code/providers',
  asyncHandler(async (req: Request, res: Response) => {
    const { rows } = await query(
      'SELECT * FROM service_providers WHERE service_code = $1 ORDER BY priority, created_at',
      [req.params.code],
    );
    res.json({ items: rows });
  }),
);

const providerSchema = z.object({
  label: z.string().trim().min(2).max(120),
  driver: z.enum(['sandbox', 'aggregator', 'razorpay', 'generic']).default('sandbox'),
  base_url: z.string().trim().max(300).optional(),
  api_key: z.string().trim().max(300).optional(),
  api_secret: z.string().trim().max(300).optional(),
  auth_token: z.string().trim().max(600).optional(),
  partner_id: z.string().trim().max(120).optional(),
  extra: z.record(z.any()).optional(),
  is_active: z.boolean().default(false),
  priority: z.coerce.number().int().default(0),
});

router.post(
  '/services/:code/providers',
  validate(providerSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof providerSchema>;
    const code = req.params.code;
    const svc = await query('SELECT 1 FROM services WHERE code = $1', [code]);
    if (!svc.rowCount) throw ApiError.notFound('Service not found');

    const provider = await withTransaction(async (client) => {
      if (b.is_active) {
        await client.query(
          'UPDATE service_providers SET is_active = false WHERE service_code = $1 AND is_active = true',
          [code],
        );
      }
      const { rows } = await client.query(
        `INSERT INTO service_providers
           (service_code, label, driver, base_url, api_key, api_secret, auth_token, partner_id, extra, is_active, priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [code, b.label, b.driver, b.base_url ?? null, b.api_key ?? null, b.api_secret ?? null,
         b.auth_token ?? null, b.partner_id ?? null, JSON.stringify(b.extra ?? {}), b.is_active, b.priority],
      );
      return rows[0];
    });
    await refreshProviderRegistry();
    res.status(201).json({ provider });
  }),
);

const providerUpdateSchema = providerSchema.partial();

router.patch(
  '/providers/:id',
  validate(providerUpdateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof providerUpdateSchema>;
    const provider = await withTransaction(async (client) => {
      const cur = await client.query<{ service_code: string }>(
        'SELECT service_code FROM service_providers WHERE id = $1',
        [req.params.id],
      );
      if (!cur.rows[0]) throw ApiError.notFound('Provider not found');
      if (b.is_active === true) {
        await client.query(
          'UPDATE service_providers SET is_active = false WHERE service_code = $1 AND is_active = true AND id <> $2',
          [cur.rows[0].service_code, req.params.id],
        );
      }
      const { rows } = await client.query(
        `UPDATE service_providers SET
            label = COALESCE($1,label), driver = COALESCE($2,driver),
            base_url = COALESCE($3,base_url), api_key = COALESCE($4,api_key),
            api_secret = COALESCE($5,api_secret), auth_token = COALESCE($6,auth_token),
            partner_id = COALESCE($7,partner_id), extra = COALESCE($8,extra),
            is_active = COALESCE($9,is_active), priority = COALESCE($10,priority)
          WHERE id = $11 RETURNING *`,
        [b.label ?? null, b.driver ?? null, b.base_url ?? null, b.api_key ?? null,
         b.api_secret ?? null, b.auth_token ?? null, b.partner_id ?? null,
         b.extra === undefined ? null : JSON.stringify(b.extra),
         b.is_active ?? null, b.priority ?? null, req.params.id],
      );
      return rows[0];
    });
    await refreshProviderRegistry();
    res.json({ provider });
  }),
);

// Make a provider the active one for its service.
router.post(
  '/providers/:id/activate',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = await withTransaction(async (client) => {
      const cur = await client.query<{ service_code: string }>(
        'SELECT service_code FROM service_providers WHERE id = $1',
        [req.params.id],
      );
      if (!cur.rows[0]) throw ApiError.notFound('Provider not found');
      await client.query(
        'UPDATE service_providers SET is_active = false WHERE service_code = $1',
        [cur.rows[0].service_code],
      );
      const { rows } = await client.query(
        'UPDATE service_providers SET is_active = true WHERE id = $1 RETURNING *',
        [req.params.id],
      );
      return rows[0];
    });
    await refreshProviderRegistry();
    res.json({ provider });
  }),
);

router.delete(
  '/providers/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { rowCount } = await query('DELETE FROM service_providers WHERE id = $1', [req.params.id]);
    if (!rowCount) throw ApiError.notFound('Provider not found');
    await refreshProviderRegistry();
    res.status(204).send();
  }),
);

export default router;
