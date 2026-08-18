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
  aadhaar_ref: z.string().trim().min(4).max(20).optional(),
  aadhaar: z.string().trim().regex(/^\d{12}$/, 'Aadhaar must be 12 digits').optional(),
  bank_iin: z.string().trim().min(3).max(12),
  mobile: z.string().trim().regex(/^[6-9]\d{9}$/).optional(),
  amount: z.coerce.number().positive().max(100000),
  pid_data: z.string().max(20000).optional(),
  biometric_type: z.enum(['FMR', 'FIR', 'IIR']).optional(),
  device_serial: z.string().trim().max(120).optional(),
  rd_service: z.string().trim().max(200).optional(),
  provider_id: z.string().uuid().optional(),
  reference: z.string().trim().max(64).optional(),
}).refine((v) => !!(v.aadhaar_ref || v.aadhaar), { message: 'Provide aadhaar or aadhaar_ref', path: ['aadhaar'] });

function maskAadhaar(full?: string, ref?: string): string {
  if (full) return `XXXXXXXX${full.slice(-4)}`;
  return ref ?? 'XXXX';
}

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'success', 'failed', 'refunded']).optional(),
});

// Aadhaar Pay merchant collection — CREDIT service (wallet += amount + comm - charge).
router.post(
  '/',
  requireService('aadhaar_pay'),
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = req.user.id;
    const body = req.body as z.infer<typeof createSchema>;
    const amountPaise = rupeesToPaise(body.amount);
    const providerId = resolveProviderChoice('aadhaar_pay', body.provider_id);
    const provider = getGenericProvider('aadhaar_pay', providerId);

    const { transaction, idempotent } = await runServiceTransaction({
      userId,
      serviceCode: 'aadhaar_pay',
      table: 'aadhaar_pay_transactions',
      prefix: 'ADPAY',
      flow: 'credit',
      reference: req.header('Idempotency-Key') || body.reference,
      amountPaise,
      description: 'Aadhaar Pay collection',
      providerName: provider.name,
      providerId,
      insertServiceRow: async (client, ctx) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO aadhaar_pay_transactions
             (user_id, aadhaar_ref, bank_iin, mobile, amount_paise, charge_paise,
              biometric_type, device_serial, rd_service, reference, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING id`,
          [userId, maskAadhaar(body.aadhaar, body.aadhaar_ref), body.bank_iin, body.mobile ?? null,
           amountPaise, ctx.chargePaise, body.biometric_type ?? null, body.device_serial ?? null,
           body.rd_service ?? null, ctx.reference],
        );
        return rows[0].id;
      },
      callProvider: ({ reference }) =>
        provider.execute('aadhaar_pay', {
          reference,
          amountPaise,
          providerId,
          meta: {
            iin: body.bank_iin,
            aadhaar: body.aadhaar,
            pid_data: body.pid_data,
            biometric_type: body.biometric_type,
          },
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
      `SELECT * FROM aadhaar_pay_transactions WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
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
    const { rows } = await query('SELECT * FROM aadhaar_pay_transactions WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (!rows[0]) throw ApiError.notFound('Aadhaar Pay transaction not found');
    res.json({ transaction: rows[0] });
  }),
);

export default router;
