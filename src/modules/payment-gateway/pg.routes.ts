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
import { getGatewayProvider } from '../../providers';
import { requireService } from '../../middleware/service';

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  amount: z.coerce.number().positive().max(1000000),
  gateway: z.enum(['razorpay', 'cashfree', 'payu']).default('razorpay'),
  purpose: z.string().trim().max(60).default('wallet_topup'),
  reference: z.string().trim().max(64).optional(),
});

const confirmSchema = z.object({
  gateway_payment_id: z.string().trim().min(1).max(120),
  // Signature returned by the gateway checkout (e.g. razorpay_signature).
  signature: z.string().trim().min(1).max(512),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'success', 'failed', 'refunded']).optional(),
});

// Create a collection order. Frontend uses the returned order to open checkout.
router.post(
  '/orders',
  requireService('payment_gateway'),
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const body = req.body as z.infer<typeof createSchema>;
    const amountPaise = rupeesToPaise(body.amount);
    const reference = body.reference ?? makeReference('PG');

    // Create the order at the gateway so the client can open checkout.
    const provider = getGatewayProvider();
    const order = await provider.createOrder({
      reference,
      amountPaise,
      currency: 'INR',
      purpose: body.purpose,
    });

    const { rows } = await query(
      `INSERT INTO pg_orders (user_id, gateway, amount_paise, purpose, reference, gateway_order_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')
       RETURNING *`,
      [req.user.id, body.gateway, amountPaise, body.purpose, reference, order.gatewayOrderId],
    );
    res.status(201).json({ order: rows[0], checkout: order.checkout });
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

      // Verify the gateway signature before trusting this as paid.
      const provider = getGatewayProvider();
      const valid = provider.verifyPayment({
        gatewayOrderId: existing.gateway_order_id,
        gatewayPaymentId: body.gateway_payment_id,
        signature: body.signature,
      });

      if (!valid) {
        await client.query(
          `UPDATE pg_orders
              SET status = 'failed', gateway_payment_id = $1, status_message = 'signature verification failed'
            WHERE id = $2`,
          [body.gateway_payment_id, existing.id],
        );
        throw ApiError.badRequest('Payment signature verification failed');
      }

      const { rows: updated } = await client.query(
        `UPDATE pg_orders
            SET status = 'success', gateway_payment_id = $1, status_message = 'payment verified'
          WHERE id = $2
          RETURNING *`,
        [body.gateway_payment_id, existing.id],
      );
      const row = updated[0];

      if (row.purpose === 'wallet_topup') {
        await credit(client, {
          userId,
          amountPaise: Number(row.amount_paise),
          source: 'payment_gateway',
          referenceId: row.id,
          description: `Wallet top-up via ${row.gateway} (${row.reference})`,
        });
      }
      // Record in the unified ledger (idempotent on reference).
      await client.query(
        `INSERT INTO transactions
           (user_id, service, direction, service_txn_id, reference, amount_paise, net_paise, status, provider, status_message)
         VALUES ($1,'payment_gateway','credit',$2,$3,$4,$4,'success',$5,'payment verified')
         ON CONFLICT (reference) DO NOTHING`,
        [userId, row.id, row.reference, Number(row.amount_paise), row.gateway],
      );
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
