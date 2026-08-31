import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';
import { rupeesToPaise } from '../../utils/money';
import { getRechargeProvider } from '../../providers';
import { runServiceTransaction } from '../_shared/transaction';
import { resolveProviderChoice, failoverCandidates } from '../_shared/providerChoice';
import { requireService } from '../../middleware/service';

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  operator: z.string().trim().min(1).max(60),
  circle: z.string().trim().max(60).optional(),
  recharge_type: z.enum(['prepaid', 'postpaid', 'dth']).default('prepaid'),
  number: z.string().trim().min(4).max(20),
  amount: z.coerce.number().positive().max(50000),
  charge: z.coerce.number().min(0).default(0),
  provider_id: z.string().uuid().optional(),
  reference: z.string().trim().max(64).optional(),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'success', 'failed', 'refunded']).optional(),
});

// Operator catalog — feeds the recharge form's operator dropdown.
router.get(
  '/operators',
  validate(z.object({ type: z.enum(['prepaid', 'postpaid', 'dth']).optional() }), 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { type?: string };
    const { rows } = await query(
      `SELECT code, name, type FROM operators
        WHERE enabled = true AND ($1::text IS NULL OR type = $1)
        ORDER BY type, sort_order, name`,
      [q.type ?? null],
    );
    res.json({ items: rows });
  }),
);

// Telecom circles — feeds the circle dropdown for prepaid/postpaid.
router.get(
  '/circles',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query('SELECT code, name FROM telecom_circles WHERE enabled = true ORDER BY name');
    res.json({ items: rows });
  }),
);

// Do a recharge: debit wallet (amount + charge), record it.
router.post(
  '/',
  requireService('recharge'),
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = req.user.id;
    const body = req.body as z.infer<typeof createSchema>;
    const amountPaise = rupeesToPaise(body.amount);
    const providerId = resolveProviderChoice('recharge', body.provider_id);
    const provider = getRechargeProvider(providerId);

    const { transaction, idempotent } = await runServiceTransaction({
      userId,
      serviceCode: 'recharge',
      table: 'recharge_transactions',
      prefix: 'RCH',
      reference: req.header('Idempotency-Key') || body.reference,
      amountPaise,
      providerId,
      clientChargePaise: rupeesToPaise(body.charge),
      description: `${body.recharge_type} recharge ${body.operator} ${body.number}`,
      providerName: provider.name,
      insertServiceRow: async (client, ctx) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO recharge_transactions
             (user_id, operator, circle, recharge_type, number, amount_paise, charge_paise, reference, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING id`,
          [userId, body.operator, body.circle ?? null, body.recharge_type, body.number, amountPaise, ctx.chargePaise, ctx.reference],
        );
        return rows[0].id;
      },
      callProvider: ({ reference }) =>
        provider.recharge({
          reference,
          amountPaise,
          operator: body.operator,
          number: body.number,
          rechargeType: body.recharge_type,
          circle: body.circle,
          providerId,
        }),
      // Auto-failover across active providers (kicks in only when the admin has
      // activated 2+ providers for recharge; advances only on a hard failure).
      failover: {
        candidates: failoverCandidates('recharge', providerId),
        call: (pid, { reference }) =>
          getRechargeProvider(pid).recharge({
            reference,
            amountPaise,
            operator: body.operator,
            number: body.number,
            rechargeType: body.recharge_type,
            circle: body.circle,
            providerId: pid,
          }),
      },
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
