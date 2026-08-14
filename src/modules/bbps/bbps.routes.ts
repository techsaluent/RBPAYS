import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { withTransaction, query } from '../../../db';
import { debit } from '../wallet/wallet.service';
import { rupeesToPaise } from '../../utils/money';
import { makeReference } from '../../utils/reference';

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  biller_id: z.string().trim().min(1).max(64),
  biller_name: z.string().trim().max(120).optional(),
  category: z.string().trim().max(60).optional(),
  consumer_number: z.string().trim().min(1).max(64),
  amount: z.coerce.number().positive().max(500000),
  charge: z.coerce.number().min(0).default(0),
  reference: z.string().trim().max(64).optional(),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'success', 'failed', 'refunded']).optional(),
});

// Pay a bill via BBPS: debit wallet (amount + charge), record the payment.
router.post(
  '/pay',
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = req.user.id;
    const body = req.body as z.infer<typeof createSchema>;
    const amountPaise = rupeesToPaise(body.amount);
    const chargePaise = rupeesToPaise(body.charge);
    const reference = body.reference ?? makeReference('BBPS');

    const txn = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO bbps_transactions
           (user_id, biller_id, biller_name, category, consumer_number, amount_paise, charge_paise, reference, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
         RETURNING *`,
        [userId, body.biller_id, body.biller_name ?? null, body.category ?? null, body.consumer_number, amountPaise, chargePaise, reference],
      );
      const created = rows[0];
      await debit(client, {
        userId,
        amountPaise: amountPaise + chargePaise,
        source: 'bbps',
        referenceId: created.id,
        description: `BBPS ${body.category ?? 'bill'} ${body.consumer_number} (${reference})`,
      });
      return created;
    });

    res.status(201).json({ transaction: txn });
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
