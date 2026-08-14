import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { withTransaction, query } from '../../../db';
import { credit } from '../wallet/wallet.service';
import { rupeesToPaise } from '../../utils/money';
import { makeReference } from '../../utils/reference';

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  amount: z.coerce.number().positive().max(1000000),
  gateway: z.enum(['razorpay', 'cashfree', 'payu']).default('razorpay'),
  purpose: z.string().trim().max(60).default('wallet_topup'),
  reference: z.string().trim().max(64).optional(),
});

const confirmSchema = z.object({
  gateway_order_id: z.string().trim().max(120).optional(),
  gateway_payment_id: z.string().trim().min(1).max(120),
  // In production, verify the gateway signature here before trusting status.
  status: z.enum(['success', 'failed']).default('success'),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'success', 'failed', 'refunded']).optional(),
});

// Create a collection order. Frontend uses the returned order to open checkout.
router.post(
  '/orders',
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const body = req.body as z.infer<typeof createSchema>;
    const amountPaise = rupeesToPaise(body.amount);
    const reference = body.reference ?? makeReference('PG');
    const { rows } = await query(
      `INSERT INTO pg_orders (user_id, gateway, amount_paise, purpose, reference, status)
       VALUES ($1,$2,$3,$4,$5,'pending')
       RETURNING *`,
      [req.user.id, body.gateway, amountPaise, body.purpose, reference],
    );
    res.status(201).json({ order: rows[0] });
  }),
);

// Confirm a payment. On success, credit the user's wallet (idempotent per order).
router.post(
  '/orders/:id/confirm',
  validate(confirmSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = req.user.id;
    const body = req.body as z.infer<typeof confirmSchema>;

    const order = await withTransaction(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM pg_orders WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [req.params.id, userId],
      );
      const existing = rows[0];
      if (!existing) throw ApiError.notFound('Order not found');
      if (existing.status !== 'pending') {
        throw ApiError.conflict(`Order already ${existing.status}`);
      }

      const newStatus = body.status;
      const { rows: updated } = await client.query(
        `UPDATE pg_orders
            SET status = $1, gateway_payment_id = $2, gateway_order_id = COALESCE($3, gateway_order_id)
          WHERE id = $4
          RETURNING *`,
        [newStatus, body.gateway_payment_id, body.gateway_order_id ?? null, existing.id],
      );
      const row = updated[0];

      if (newStatus === 'success' && row.purpose === 'wallet_topup') {
        await credit(client, {
          userId,
          amountPaise: Number(row.amount_paise),
          source: 'payment_gateway',
          referenceId: row.id,
          description: `Wallet top-up via ${row.gateway} (${row.reference})`,
        });
      }
      return row;
    });

    res.json({ order });
  }),
);

router.get(
  '/orders',
  validate(listSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const q = req.query as unknown as z.infer<typeof listSchema>;
    const { rows } = await query(
      `SELECT * FROM pg_orders
        WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4`,
      [req.user.id, q.status ?? null, q.limit, q.offset],
    );
    res.json({ items: rows, limit: q.limit, offset: q.offset });
  }),
);

router.get(
  '/orders/:id',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rows } = await query(
      'SELECT * FROM pg_orders WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id],
    );
    if (!rows[0]) throw ApiError.notFound('Order not found');
    res.json({ order: rows[0] });
  }),
);

export default router;
