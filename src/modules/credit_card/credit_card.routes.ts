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
import { resolveProviderChoice } from '../_shared/providerChoice';
import { requireService } from '../../middleware/service';

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  issuer: z.string().trim().max(120).optional(),
  card_number: z.string().trim().min(4).max(19),
  customer_name: z.string().trim().max(120).optional(),
  amount: z.coerce.number().positive().max(1000000),
  charge: z.coerce.number().min(0).default(0),
  provider_id: z.string().uuid().optional(),
  reference: z.string().trim().max(64).optional(),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'success', 'failed', 'refunded']).optional(),
});

const last4 = (n: string) => (n.length > 4 ? '**** ' + n.slice(-4) : n);

// Credit-card bill payment — DEBIT/earning service.
router.post(
  '/pay',
  requireService('credit_card'),
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = req.user.id;
    const body = req.body as z.infer<typeof createSchema>;
    const amountPaise = rupeesToPaise(body.amount);
    const providerId = resolveProviderChoice('credit_card', body.provider_id);
    const provider = getGenericProvider('credit_card', providerId);

    const { transaction, idempotent } = await runServiceTransaction({
      userId,
      serviceCode: 'credit_card',
      table: 'credit_card_transactions',
      prefix: 'CC',
      reference: req.header('Idempotency-Key') || body.reference,
      amountPaise,
      clientChargePaise: rupeesToPaise(body.charge),
      dedupeKey: `${body.card_number}`,
      description: `Credit card bill ${body.issuer ?? ''} ${last4(body.card_number)}`.trim(),
      providerName: provider.name,
      providerId,
      insertServiceRow: async (client, ctx) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO credit_card_transactions
             (user_id, issuer, card_number, customer_name, amount_paise, charge_paise, reference, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,
          // store only the masked card number in our ledger
          [userId, body.issuer ?? null, last4(body.card_number), body.customer_name ?? null, amountPaise, ctx.chargePaise, ctx.reference],
        );
        return rows[0].id;
      },
      callProvider: ({ reference }) =>
        provider.execute('credit_card', {
          reference, amountPaise, providerId,
          meta: { issuer: body.issuer, card_number: body.card_number },
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
      `SELECT * FROM credit_card_transactions WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
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
    const { rows } = await query('SELECT * FROM credit_card_transactions WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (!rows[0]) throw ApiError.notFound('Credit card transaction not found');
    res.json({ transaction: rows[0] });
  }),
);

export default router;
