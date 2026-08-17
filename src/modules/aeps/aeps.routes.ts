import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';
import { rupeesToPaise } from '../../utils/money';
import { getAepsProvider } from '../../providers';
import { runServiceTransaction } from '../_shared/transaction';
import { requireService } from '../../middleware/service';
import { aepsSplitSuppressesCommission } from '../risk/risk.service';

const router = Router();
router.use(requireAuth);

type TxnType = 'cash_withdrawal' | 'balance_enquiry' | 'mini_statement';

const baseFields = {
  aadhaar_ref: z.string().trim().min(4).max(20), // masked ref / last digits — never full biometric
  bank_iin: z.string().trim().min(3).max(12),
  bank_name: z.string().trim().max(120).optional(),
  mobile: z.string().trim().regex(/^[6-9]\d{9}$/).optional(),
  reference: z.string().trim().max(64).optional(),
};
const withdrawalSchema = z.object({ ...baseFields, amount: z.coerce.number().positive().max(10000) });
const enquirySchema = z.object(baseFields);

// AEPS is a CREDIT/earning service: on success the retailer's wallet is credited
// the withdrawn amount plus their commission (net = amount + commission - charge).
async function runAeps(req: Request, res: Response, txnType: TxnType, amountPaise: number, body: Record<string, unknown>) {
  if (!req.user) throw ApiError.unauthorized();
  const userId = req.user.id;
  const provider = getAepsProvider();

  // Commission-farming guard: same Aadhaar again within the window at this
  // terminal keeps serving the customer but strips hierarchy commission.
  const suppressCommission =
    txnType === 'cash_withdrawal'
      ? await aepsSplitSuppressesCommission(userId, body.aadhaar_ref as string)
      : true; // enquiries never earn commission

  const { transaction, idempotent } = await runServiceTransaction({
    userId,
    serviceCode: 'aeps',
    table: 'aeps_transactions',
    prefix: 'AEPS',
    flow: 'credit',
    suppressCommission,
    reference: (req.header('Idempotency-Key') || (body.reference as string)) ?? undefined,
    amountPaise,
    description: `AEPS ${txnType}`,
    providerName: provider.name,
    insertServiceRow: async (client, ctx) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO aeps_transactions
           (user_id, txn_type, aadhaar_ref, bank_iin, bank_name, mobile, amount_paise, charge_paise, reference, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING id`,
        [userId, txnType, body.aadhaar_ref, body.bank_iin, body.bank_name ?? null, body.mobile ?? null, amountPaise, ctx.chargePaise, ctx.reference],
      );
      return rows[0].id;
    },
    callProvider: ({ reference }) =>
      provider.execute({
        reference,
        txnType,
        amountPaise,
        aadhaarRef: body.aadhaar_ref as string,
        bankIin: body.bank_iin as string,
        mobile: body.mobile as string | undefined,
      }),
  });

  res.status(idempotent ? 200 : 201).json({ transaction, idempotent });
}

router.post(
  '/cash-withdrawal',
  requireService('aeps'),
  validate(withdrawalSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof withdrawalSchema>;
    await runAeps(req, res, 'cash_withdrawal', rupeesToPaise(body.amount), body);
  }),
);

router.post(
  '/balance-enquiry',
  requireService('aeps'),
  validate(enquirySchema),
  asyncHandler(async (req, res) => {
    await runAeps(req, res, 'balance_enquiry', 0, req.body);
  }),
);

router.post(
  '/mini-statement',
  requireService('aeps'),
  validate(enquirySchema),
  asyncHandler(async (req, res) => {
    await runAeps(req, res, 'mini_statement', 0, req.body);
  }),
);

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'success', 'failed', 'refunded']).optional(),
});

router.get(
  '/',
  validate(listSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const q = req.query as unknown as z.infer<typeof listSchema>;
    const { rows } = await query(
      `SELECT * FROM aeps_transactions
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
    const { rows } = await query('SELECT * FROM aeps_transactions WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (!rows[0]) throw ApiError.notFound('AEPS transaction not found');
    res.json({ transaction: rows[0] });
  }),
);

export default router;
