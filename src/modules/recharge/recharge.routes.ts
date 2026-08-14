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
  operator: z.string().trim().min(1).max(60),
  circle: z.string().trim().max(60).optional(),
  recharge_type: z.enum(['prepaid', 'postpaid', 'dth']).default('prepaid'),
  number: z.string().trim().min(4).max(20),
  amount: z.coerce.number().positive().max(50000),
  charge: z.coerce.number().min(0).default(0),
  reference: z.string().trim().max(64).optional(),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'success', 'failed', 'refunded']).optional(),
});

// Do a recharge: debit wallet (amount + charge), record it.
router.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = req.user.id;
    const body = req.body as z.infer<typeof createSchema>;
    const amountPaise = rupeesToPaise(body.amount);
    const chargePaise = rupeesToPaise(body.charge);
    const reference = body.reference ?? makeReference('RCH');

    const txn = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO recharge_transactions
           (user_id, operator, circle, recharge_type, number, amount_paise, charge_paise, reference, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
         RETURNING *`,
        [userId, body.operator, body.circle ?? null, body.recharge_type, body.number, amountPaise, chargePaise, reference],
      );
      const created = rows[0];
      await debit(client, {
        userId,
        amountPaise: amountPaise + chargePaise,
        source: 'recharge',
        referenceId: created.id,
        description: `${body.recharge_type} recharge ${body.operator} ${body.number} (${reference})`,
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
      `SELECT * FROM recharge_transactions
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
      'SELECT * FROM recharge_transactions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id],
    );
    if (!rows[0]) throw ApiError.notFound('Recharge transaction not found');
    res.json({ transaction: rows[0] });
  }),
);

export default router;
