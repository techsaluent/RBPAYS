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
  lender: z.string().trim().max(120).optional(),
  loan_account_no: z.string().trim().min(3).max(64),
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

// Loan repayment (EMI / part-payment collection) — DEBIT/earning service.
router.post(
  '/pay',
  requireService('loan'),
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = req.user.id;
    const body = req.body as z.infer<typeof createSchema>;
    const amountPaise = rupeesToPaise(body.amount);
    const providerId = resolveProviderChoice('loan', body.provider_id);
    const provider = getGenericProvider('loan', providerId);

    const { transaction, idempotent } = await runServiceTransaction({
      userId,
      serviceCode: 'loan',
      table: 'loan_transactions',
      prefix: 'LOAN',
      reference: req.header('Idempotency-Key') || body.reference,
      amountPaise,
      clientChargePaise: rupeesToPaise(body.charge),
      dedupeKey: `${body.loan_account_no}`,
      description: `Loan repayment ${body.lender ?? ''} ${body.loan_account_no}`.trim(),
      providerName: provider.name,
      providerId,
      insertServiceRow: async (client, ctx) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO loan_transactions
             (user_id, lender, loan_account_no, customer_name, amount_paise, charge_paise, reference, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,
          [userId, body.lender ?? null, body.loan_account_no, body.customer_name ?? null, amountPaise, ctx.chargePaise, ctx.reference],
        );
        return rows[0].id;
      },
      callProvider: ({ reference }) =>
        provider.execute('loan', {
          reference, amountPaise, providerId,
          meta: { lender: body.lender, loan_account_no: body.loan_account_no },
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
      `SELECT * FROM loan_transactions WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
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
    const { rows } = await query('SELECT * FROM loan_transactions WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (!rows[0]) throw ApiError.notFound('Loan transaction not found');
    res.json({ transaction: rows[0] });
  }),
);

export default router;
