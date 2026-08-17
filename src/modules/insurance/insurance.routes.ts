import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';
import { rupeesToPaise } from '../../utils/money';
import { getGenericProvider } from '../../providers';
import { runServiceTransaction } from '../_shared/transaction';
import { requireService } from '../../middleware/service';

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  category: z.enum(['motor', 'health', 'life', 'travel', 'personal_accident', 'other']),
  insurer: z.string().trim().max(120).optional(),
  customer_name: z.string().trim().max(120).optional(),
  policy_number: z.string().trim().max(64).optional(),
  amount: z.coerce.number().positive().max(1000000), // premium
  charge: z.coerce.number().min(0).default(0),
  reference: z.string().trim().max(64).optional(),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'success', 'failed', 'refunded']).optional(),
});

// Insurance policy sale (premium collection) — DEBIT/earning service.
router.post(
  '/buy',
  requireService('insurance'),
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = req.user.id;
    const body = req.body as z.infer<typeof createSchema>;
    const amountPaise = rupeesToPaise(body.amount);
    const provider = getGenericProvider('insurance');

    const { transaction, idempotent } = await runServiceTransaction({
      userId,
      serviceCode: 'insurance',
      table: 'insurance_transactions',
      prefix: 'INS',
      reference: req.header('Idempotency-Key') || body.reference,
      amountPaise,
      clientChargePaise: rupeesToPaise(body.charge),
      description: `${body.category} insurance ${body.insurer ?? ''}`.trim(),
      providerName: provider.name,
      insertServiceRow: async (client, ctx) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO insurance_transactions
             (user_id, category, insurer, customer_name, policy_number, amount_paise, charge_paise, reference, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING id`,
          [userId, body.category, body.insurer ?? null, body.customer_name ?? null, body.policy_number ?? null, amountPaise, ctx.chargePaise, ctx.reference],
        );
        return rows[0].id;
      },
      callProvider: ({ reference }) =>
        provider.execute('insurance', { reference, amountPaise, meta: { category: body.category } }),
    });

    res.status(idempotent ? 200 : 201).json({ transaction, idempotent });
  }),
);

router.get(
  '/',
  validate(listSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const q = req.query as unknown as z.infer<typeof listSchema>;
    const { rows } = await query(
      `SELECT * FROM insurance_transactions WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [req.user.id, q.status ?? null, q.limit, q.offset],
    );
    res.json({ items: rows, limit: q.limit, offset: q.offset });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rows } = await query('SELECT * FROM insurance_transactions WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (!rows[0]) throw ApiError.notFound('Insurance transaction not found');
    res.json({ transaction: rows[0] });
  }),
);

export default router;
