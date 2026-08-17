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
  booking_type: z.enum(['flight', 'bus', 'train', 'hotel']),
  operator: z.string().trim().max(120).optional(),
  from_location: z.string().trim().max(120).optional(),
  to_location: z.string().trim().max(120).optional(),
  travel_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  passenger_name: z.string().trim().max(120).optional(),
  amount: z.coerce.number().positive().max(1000000),
  charge: z.coerce.number().min(0).default(0),
  reference: z.string().trim().max(64).optional(),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'success', 'failed', 'refunded']).optional(),
});

// Travel booking (flight/bus/train/hotel) — DEBIT/earning service.
router.post(
  '/book',
  requireService('travel'),
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = req.user.id;
    const body = req.body as z.infer<typeof createSchema>;
    const amountPaise = rupeesToPaise(body.amount);
    const provider = getGenericProvider('travel');

    const { transaction, idempotent } = await runServiceTransaction({
      userId,
      serviceCode: 'travel',
      table: 'travel_transactions',
      prefix: 'TRV',
      reference: req.header('Idempotency-Key') || body.reference,
      amountPaise,
      clientChargePaise: rupeesToPaise(body.charge),
      description: `${body.booking_type} booking ${body.from_location ?? ''}-${body.to_location ?? ''}`.trim(),
      providerName: provider.name,
      insertServiceRow: async (client, ctx) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO travel_transactions
             (user_id, booking_type, operator, from_location, to_location, travel_date, passenger_name, amount_paise, charge_paise, reference, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING id`,
          [userId, body.booking_type, body.operator ?? null, body.from_location ?? null, body.to_location ?? null,
           body.travel_date ?? null, body.passenger_name ?? null, amountPaise, ctx.chargePaise, ctx.reference],
        );
        return rows[0].id;
      },
      callProvider: ({ reference }) =>
        provider.execute('travel', { reference, amountPaise, meta: { booking_type: body.booking_type } }),
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
      `SELECT * FROM travel_transactions WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
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
    const { rows } = await query('SELECT * FROM travel_transactions WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (!rows[0]) throw ApiError.notFound('Travel booking not found');
    res.json({ transaction: rows[0] });
  }),
);

export default router;
