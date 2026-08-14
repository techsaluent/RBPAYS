import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';
import { rupeesToPaise } from '../../utils/money';
import { getCmsProvider } from '../../providers';
import { runServiceTransaction } from '../_shared/transaction';
import { requireService } from '../../middleware/service';

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  agent_id: z.string().trim().min(1).max(64), // company / biller code
  biller_name: z.string().trim().max(120).optional(),
  account_number: z.string().trim().min(1).max(64),
  customer_name: z.string().trim().max(120).optional(),
  amount: z.coerce.number().positive().max(200000),
  charge: z.coerce.number().min(0).default(0),
  reference: z.string().trim().max(64).optional(),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'success', 'failed', 'refunded']).optional(),
});

// CMS cash collection is a DEBIT/earning service (like BBPS): the retailer's
// wallet is net-debited (amount + charge - commission) and upline earns.
router.post(
  '/pay',
  requireService('cms'),
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = req.user.id;
    const body = req.body as z.infer<typeof createSchema>;
    const amountPaise = rupeesToPaise(body.amount);
    const provider = getCmsProvider();

    const { transaction, idempotent } = await runServiceTransaction({
      userId,
      serviceCode: 'cms',
      table: 'cms_transactions',
      prefix: 'CMS',
      reference: req.header('Idempotency-Key') || body.reference,
      amountPaise,
      clientChargePaise: rupeesToPaise(body.charge),
      description: `CMS ${body.biller_name ?? body.agent_id} ${body.account_number}`,
      providerName: provider.name,
      insertServiceRow: async (client, ctx) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO cms_transactions
             (user_id, agent_id, biller_name, account_number, customer_name, amount_paise, charge_paise, reference, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING id`,
          [userId, body.agent_id, body.biller_name ?? null, body.account_number, body.customer_name ?? null, amountPaise, ctx.chargePaise, ctx.reference],
        );
        return rows[0].id;
      },
      callProvider: ({ reference }) =>
        provider.pay({
          reference,
          amountPaise,
          agentId: body.agent_id,
          accountNumber: body.account_number,
          customerName: body.customer_name,
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
      `SELECT * FROM cms_transactions
        WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
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
    const { rows } = await query('SELECT * FROM cms_transactions WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (!rows[0]) throw ApiError.notFound('CMS transaction not found');
    res.json({ transaction: rows[0] });
  }),
);

export default router;
