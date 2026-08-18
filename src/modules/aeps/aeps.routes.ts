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
import { resolveProviderChoice } from '../_shared/providerChoice';
import { requireService } from '../../middleware/service';
import { aepsSplitSuppressesCommission } from '../risk/risk.service';

const router = Router();
router.use(requireAuth);

type TxnType = 'cash_withdrawal' | 'balance_enquiry' | 'mini_statement';

const baseFields = {
  // Sandbox path uses a masked ref; the live biometric path sends the full
  // 12-digit Aadhaar plus the RD-service PID block (never stored).
  aadhaar_ref: z.string().trim().min(4).max(20).optional(),
  aadhaar: z.string().trim().regex(/^\d{12}$/, 'Aadhaar must be 12 digits').optional(),
  bank_iin: z.string().trim().min(3).max(12),
  bank_name: z.string().trim().max(120).optional(),
  mobile: z.string().trim().regex(/^[6-9]\d{9}$/).optional(),
  // Biometric block from the RD service (forwarded to the switch in-memory):
  pid_data: z.string().max(20000).optional(),
  biometric_type: z.enum(['FMR', 'FIR', 'IIR']).optional(),
  device_serial: z.string().trim().max(120).optional(),
  rd_service: z.string().trim().max(200).optional(),
  provider_id: z.string().uuid().optional(),
  reference: z.string().trim().max(64).optional(),
};
const hasAadhaar = (v: { aadhaar_ref?: string; aadhaar?: string }) => !!(v.aadhaar_ref || v.aadhaar);
const withdrawalSchema = z
  .object({ ...baseFields, amount: z.coerce.number().positive().max(10000) })
  .refine(hasAadhaar, { message: 'Provide aadhaar or aadhaar_ref', path: ['aadhaar'] });
const enquirySchema = z.object(baseFields).refine(hasAadhaar, { message: 'Provide aadhaar or aadhaar_ref', path: ['aadhaar'] });

/** Mask a full Aadhaar to a stored reference (only last 4 kept). */
function maskAadhaar(full?: string, ref?: string): string {
  if (full) return `XXXXXXXX${full.slice(-4)}`;
  return ref ?? 'XXXX';
}

// AEPS is a CREDIT/earning service: on success the retailer's wallet is credited
// the withdrawn amount plus their commission (net = amount + commission - charge).
async function runAeps(req: Request, res: Response, txnType: TxnType, amountPaise: number, body: Record<string, unknown>) {
  if (!req.user) throw ApiError.unauthorized();
  const userId = req.user.id;
  const providerId = resolveProviderChoice('aeps', body.provider_id as string | undefined);
  const provider = getAepsProvider(providerId);

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
    providerId,
    description: `AEPS ${txnType}`,
    providerName: provider.name,
    insertServiceRow: async (client, ctx) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO aeps_transactions
           (user_id, txn_type, aadhaar_ref, bank_iin, bank_name, mobile, amount_paise, charge_paise,
            biometric_type, device_serial, rd_service, reference, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending') RETURNING id`,
        [userId, txnType, maskAadhaar(body.aadhaar as string, body.aadhaar_ref as string), body.bank_iin,
         body.bank_name ?? null, body.mobile ?? null, amountPaise, ctx.chargePaise,
         body.biometric_type ?? null, body.device_serial ?? null, body.rd_service ?? null, ctx.reference],
      );
      return rows[0].id;
    },
    callProvider: ({ reference }) =>
      provider.execute({
        reference,
        txnType,
        amountPaise,
        aadhaarRef: maskAadhaar(body.aadhaar as string, body.aadhaar_ref as string),
        aadhaarNumber: body.aadhaar as string | undefined,
        pidData: body.pid_data as string | undefined,
        biometricType: body.biometric_type as string | undefined,
        bankIin: body.bank_iin as string,
        mobile: body.mobile as string | undefined,
        providerId,
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
