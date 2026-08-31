import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';
import { rupeesToPaise } from '../../utils/money';
import { getDmtProvider } from '../../providers';
import { runServiceTransaction } from '../_shared/transaction';
import { resolveProviderChoice, failoverCandidates } from '../_shared/providerChoice';
import { requireService } from '../../middleware/service';
import { env } from '../../config/env';
import { assertNotDmtStructuring } from '../risk/risk.service';

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  beneficiary_name: z.string().trim().min(2).max(120),
  account_number: z.string().trim().regex(/^\d{6,20}$/, 'Invalid account number'),
  ifsc: z.string().trim().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC'),
  amount: z.coerce.number().positive().max(200000),
  mode: z.enum(['IMPS', 'NEFT', 'RTGS']).default('IMPS'),
  charge: z.coerce.number().min(0).default(0),
  remitter_mobile: z.string().trim().regex(/^[6-9]\d{9}$/, 'Invalid remitter mobile').optional(),
  provider_id: z.string().uuid().optional(),
  reference: z.string().trim().max(64).optional(),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'success', 'failed', 'refunded']).optional(),
});

// Create a DMT transfer. Net-debits the wallet, calls the provider, settles.
// Idempotent by `reference` / `Idempotency-Key` — a repeat returns the original.
router.post(
  '/',
  requireService('dmt'),
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = req.user.id;
    const body = req.body as z.infer<typeof createSchema>;
    const amountPaise = rupeesToPaise(body.amount);

    // ---- RBI DMT compliance limits (per RBI Domestic Money Transfer rules) ----
    // Per-transaction ceiling and per-remitter calendar-month cap.
    if (amountPaise > env.DMT_MAX_PER_TXN_PAISE) {
      throw ApiError.unprocessable(
        `DMT amount exceeds the per-transaction limit of ₹${(env.DMT_MAX_PER_TXN_PAISE / 100).toLocaleString('en-IN')}`,
      );
    }
    const { rows: monthRows } = await query<{ sum: string | null }>(
      `SELECT COALESCE(SUM(amount_paise), 0)::text AS sum
         FROM dmt_transactions
        WHERE user_id = $1
          AND status IN ('pending', 'success')
          AND created_at >= date_trunc('month', now())`,
      [userId],
    );
    const spentThisMonth = BigInt(monthRows[0]?.sum ?? '0');
    if (spentThisMonth + BigInt(amountPaise) > BigInt(env.DMT_MAX_PER_MONTH_PAISE)) {
      throw ApiError.unprocessable(
        `This transfer would exceed the monthly DMT limit of ₹${(env.DMT_MAX_PER_MONTH_PAISE / 100).toLocaleString('en-IN')} per remitter`,
      );
    }

    // AML: reject repeated just-under-limit transfers (structuring / smurfing).
    await assertNotDmtStructuring({ userId, amountPaise, remitterMobile: body.remitter_mobile });

    const providerId = resolveProviderChoice('dmt', body.provider_id);
    const provider = getDmtProvider(providerId);

    const { transaction, idempotent } = await runServiceTransaction({
      userId,
      serviceCode: 'dmt',
      table: 'dmt_transactions',
      prefix: 'DMT',
      reference: req.header('Idempotency-Key') || body.reference,
      amountPaise,
      providerId,
      clientChargePaise: rupeesToPaise(body.charge),
      dedupeKey: `${body.account_number}|${body.ifsc}|${body.mode}`,
      description: `DMT to ${body.beneficiary_name}`,
      providerName: provider.name,
      insertServiceRow: async (client, ctx) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO dmt_transactions
             (user_id, beneficiary_name, account_number, ifsc, amount_paise, charge_paise, mode, reference, remitter_mobile, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING id`,
          [userId, body.beneficiary_name, body.account_number, body.ifsc, amountPaise, ctx.chargePaise, body.mode, ctx.reference, body.remitter_mobile ?? null],
        );
        return rows[0].id;
      },
      callProvider: ({ reference }) =>
        provider.transfer({
          reference,
          amountPaise,
          beneficiaryName: body.beneficiary_name,
          accountNumber: body.account_number,
          ifsc: body.ifsc,
          mode: body.mode,
          providerId,
        }),
      failover: {
        candidates: failoverCandidates('dmt', providerId),
        call: (pid, { reference }) =>
          getDmtProvider(pid).transfer({
            reference,
            amountPaise,
            beneficiaryName: body.beneficiary_name,
            accountNumber: body.account_number,
            ifsc: body.ifsc,
            mode: body.mode,
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
      `SELECT * FROM dmt_transactions
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
      'SELECT * FROM dmt_transactions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id],
    );
    if (!rows[0]) throw ApiError.notFound('DMT transaction not found');
    res.json({ transaction: rows[0] });
  }),
);

export default router;
