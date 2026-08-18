import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';
import { rupeesToPaise } from '../../utils/money';
import { getBbpsProvider } from '../../providers';
import { runServiceTransaction } from '../_shared/transaction';
import { resolveProviderChoice } from '../_shared/providerChoice';
import { requireService } from '../../middleware/service';

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  biller_id: z.string().trim().min(1).max(64),
  biller_name: z.string().trim().max(120).optional(),
  category: z.string().trim().max(60).optional(),
  consumer_number: z.string().trim().min(1).max(64),
  amount: z.coerce.number().positive().max(500000),
  charge: z.coerce.number().min(0).default(0),
  provider_id: z.string().uuid().optional(),
  reference: z.string().trim().max(64).optional(),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'success', 'failed', 'refunded']).optional(),
});

// Biller catalogue — Fastag, insurance, LPG, electricity, credit card, loan, etc.
// are all BBPS biller categories, discoverable here and paid via POST /bbps/pay.
router.get(
  '/billers',
  validate(z.object({ category: z.string().trim().max(40).optional() }), 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const category = (req.query as { category?: string }).category ?? null;
    const { rows } = await query(
      `SELECT biller_id, name, category, coverage FROM billers
        WHERE enabled = true AND ($1::text IS NULL OR category = $1)
        ORDER BY category, name`,
      [category],
    );
    res.json({ items: rows });
  }),
);

// Distinct biller categories offered.
router.get(
  '/categories',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query(
      'SELECT category, COUNT(*)::int AS billers FROM billers WHERE enabled = true GROUP BY category ORDER BY category',
    );
    res.json({ items: rows });
  }),
);

// Pay a bill via BBPS: debit wallet (amount + charge), record the payment.
router.post(
  '/pay',
  requireService('bbps'),
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = req.user.id;
    const body = req.body as z.infer<typeof createSchema>;
    const amountPaise = rupeesToPaise(body.amount);
    const providerId = resolveProviderChoice('bbps', body.provider_id);
    const provider = getBbpsProvider(providerId);

    const { transaction, idempotent } = await runServiceTransaction({
      userId,
      serviceCode: 'bbps',
      table: 'bbps_transactions',
      prefix: 'BBPS',
      reference: req.header('Idempotency-Key') || body.reference,
      amountPaise,
      providerId,
      clientChargePaise: rupeesToPaise(body.charge),
      description: `BBPS ${body.category ?? 'bill'} ${body.consumer_number}`,
      providerName: provider.name,
      insertServiceRow: async (client, ctx) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO bbps_transactions
             (user_id, biller_id, biller_name, category, consumer_number, amount_paise, charge_paise, reference, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING id`,
          [userId, body.biller_id, body.biller_name ?? null, body.category ?? null, body.consumer_number, amountPaise, ctx.chargePaise, ctx.reference],
        );
        return rows[0].id;
      },
      callProvider: ({ reference }) =>
        provider.pay({
          reference,
          amountPaise,
          billerId: body.biller_id,
          consumerNumber: body.consumer_number,
          category: body.category,
          providerId,
        }),
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
      `SELECT * FROM bbps_transactions
        WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4`,
      [req.user.id, q.status ?? null, q.limit, q.offset],
    );
    res.json({ items: rows, limit: q.limit, offset: q.offset });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rows } = await query(
      'SELECT * FROM bbps_transactions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id],
    );
    if (!rows[0]) throw ApiError.notFound('BBPS transaction not found');
    res.json({ transaction: rows[0] });
  }),
);

export default router;
