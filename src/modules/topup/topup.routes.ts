import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';
import { rupeesToPaise, bigintToNumber, paiseToRupees } from '../../utils/money';

/**
 * Wallet top-up (self-service) for every network role. A member deposits
 * money into one of the company bank accounts (cash / bank transfer / UPI)
 * and submits the reference here; admin verifies and credits the wallet.
 */
const router = Router();
router.use(requireAuth);

// Company bank accounts a member can deposit into (active ones only).
router.get(
  '/bank-accounts',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query(
      `SELECT id, label, bank_name, account_name, account_number, ifsc, branch, upi_id, instructions
         FROM company_bank_accounts
        WHERE is_active = true
        ORDER BY sort_order, created_at`,
    );
    res.json({ items: rows });
  }),
);

const createSchema = z.object({
  amount: z.coerce.number().positive().max(1_000_000),
  method: z.enum(['cash_deposit', 'bank_transfer', 'upi', 'gateway', 'other']),
  bank_account_id: z.string().uuid().optional(),
  reference: z.string().trim().max(80).optional(),
  proof_url: z.string().trim().url().max(500).optional(),
  note: z.string().trim().max(300).optional(),
});

// Submit a top-up request.
router.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof createSchema>;

    if (b.bank_account_id) {
      const acc = await query('SELECT 1 FROM company_bank_accounts WHERE id = $1 AND is_active = true', [
        b.bank_account_id,
      ]);
      if (!acc.rowCount) throw ApiError.badRequest('Invalid or inactive bank account');
    }

    const { rows } = await query(
      `INSERT INTO wallet_topup_requests
         (user_id, amount_paise, method, bank_account_id, reference, proof_url, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, amount_paise, method, bank_account_id, reference, status, created_at`,
      [
        req.user.id,
        rupeesToPaise(b.amount),
        b.method,
        b.bank_account_id ?? null,
        b.reference ?? null,
        b.proof_url ?? null,
        b.note ?? null,
      ],
    );
    const r = rows[0] as { amount_paise: string };
    res.status(201).json({
      request: { ...rows[0], amount_paise: bigintToNumber(r.amount_paise), amount: paiseToRupees(r.amount_paise) },
    });
  }),
);

const listSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// My top-up requests.
router.get(
  '/',
  validate(listSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const q = req.query as unknown as z.infer<typeof listSchema>;
    const { rows } = await query(
      `SELECT id, amount_paise, method, bank_account_id, reference, proof_url, note,
              status, remarks, reviewed_at, created_at
         FROM wallet_topup_requests
        WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4`,
      [req.user.id, q.status ?? null, q.limit, q.offset],
    );
    res.json({
      items: rows.map((r) => ({
        ...r,
        amount_paise: bigintToNumber(r.amount_paise as string),
        amount: paiseToRupees(r.amount_paise as string),
      })),
      limit: q.limit,
      offset: q.offset,
    });
  }),
);

export default router;
