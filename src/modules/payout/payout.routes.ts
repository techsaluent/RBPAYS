import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { withTransaction, query } from '../../../db';
import { debit } from '../wallet/wallet.service';
import { rupeesToPaise } from '../../utils/money';
import { makeReference } from '../../utils/reference';
import { getPayoutProvider } from '../../providers';
import { settleServiceTxn } from '../_shared/settle';

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  beneficiary_name: z.string().trim().min(2).max(120),
  account_number: z.string().trim().regex(/^\d{6,20}$/, 'Invalid account number'),
  ifsc: z.string().trim().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC'),
  amount: z.coerce.number().positive().max(1000000),
  mode: z.enum(['IMPS', 'NEFT', 'RTGS', 'UPI']).default('IMPS'),
  charge: z.coerce.number().min(0).default(0),
  reference: z.string().trim().max(64).optional(),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'success', 'failed', 'refunded']).optional(),
});

// Initiate a payout: debit wallet (amount + charge), record it.
router.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = req.user.id;
    const body = req.body as z.infer<typeof createSchema>;
    const amountPaise = rupeesToPaise(body.amount);
    const chargePaise = rupeesToPaise(body.charge);
    const reference = body.reference ?? makeReference('PO');

    const debitPaise = amountPaise + chargePaise;
    // 1) Reserve funds: create the txn and debit the wallet atomically.
    const txn = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO payout_transactions
           (user_id, beneficiary_name, account_number, ifsc, amount_paise, charge_paise, mode, reference, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
         RETURNING *`,
        [userId, body.beneficiary_name, body.account_number, body.ifsc, amountPaise, chargePaise, body.mode, reference],
      );
      const created = rows[0];
      await debit(client, {
        userId,
        amountPaise: debitPaise,
        source: 'payout',
        referenceId: created.id,
        description: `Payout to ${body.beneficiary_name} via ${body.mode} (${reference})`,
      });
      return created;
    });

    // 2) Call the payout provider, then settle the outcome.
    const provider = getPayoutProvider();
    const result = await provider.payout({
      reference,
      amountPaise,
      beneficiaryName: body.beneficiary_name,
      accountNumber: body.account_number,
      ifsc: body.ifsc,
      mode: body.mode,
    });
    await settleServiceTxn({
      table: 'payout_transactions',
      txnId: txn.id,
      userId,
      providerName: provider.name,
      result,
    });

    const { rows } = await query('SELECT * FROM payout_transactions WHERE id = $1', [txn.id]);
    res.status(201).json({ transaction: rows[0] });
  }),
);

router.get(
  '/',
  validate(listSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const q = req.query as unknown as z.infer<typeof listSchema>;
    const { rows } = await query(
      `SELECT * FROM payout_transactions
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
      'SELECT * FROM payout_transactions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id],
    );
    if (!rows[0]) throw ApiError.notFound('Payout transaction not found');
    res.json({ transaction: rows[0] });
  }),
);

export default router;
