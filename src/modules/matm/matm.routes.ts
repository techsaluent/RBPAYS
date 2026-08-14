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
  amount: z.coerce.number().positive().max(10000),
  card_network: z.enum(['visa', 'mastercard', 'rupay', 'amex']).optional(),
  card_last4: z.string().trim().regex(/^\d{4}$/).optional(),
  reference: z.string().trim().max(64).optional(),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'success', 'failed', 'refunded']).optional(),
});

// Micro ATM card cash withdrawal — CREDIT service (wallet += amount + commission).
router.post(
  '/withdrawal',
  requireService('matm'),
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = req.user.id;
    const body = req.body as z.infer<typeof createSchema>;
    const amountPaise = rupeesToPaise(body.amount);
    const provider = getGenericProvider('matm');

    const { transaction, idempotent } = await runServiceTransaction({
      userId,
      serviceCode: 'matm',
      table: 'matm_transactions',
      prefix: 'MATM',
      flow: 'credit',
      reference: req.header('Idempotency-Key') || body.reference,
      amountPaise,
      description: 'Micro ATM withdrawal',
      providerName: provider.name,
      insertServiceRow: async (client, ctx) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO matm_transactions (user_id, card_network, card_last4, amount_paise, charge_paise, reference, status)
           VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id`,
          [userId, body.card_network ?? null, body.card_last4 ?? null, amountPaise, ctx.chargePaise, ctx.reference],
        );
        return rows[0].id;
      },
      callProvider: ({ reference }) => provider.execute('matm', { reference, amountPaise }),
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
      `SELECT * FROM matm_transactions WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
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
    const { rows } = await query('SELECT * FROM matm_transactions WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (!rows[0]) throw ApiError.notFound('Micro ATM transaction not found');
    res.json({ transaction: rows[0] });
  }),
);

export default router;
