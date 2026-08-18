import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { withTransaction } from '../../../db';
import { rupeesToPaise } from '../../utils/money';
import { getWalletByUser, listLedger, credit } from './wallet.service';
import { subBalances, debitSub } from './subwallet.service';
import { postJournal } from '../_shared/ledger';
import { requestWithdrawal } from '../withdrawal/withdrawal.service';
import { query } from '../../../db';

const router = Router();
router.use(requireAuth);

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const [wallet, sub] = await Promise.all([getWalletByUser(req.user.id), subBalances(req.user.id)]);
    res.json({ wallet, sub_wallets: sub });
  }),
);

const sweepSchema = z.object({
  from: z.enum(['commission', 'settlement']),
  amount: z.coerce.number().positive().max(1_000_000),
});

// Move a sub-wallet balance (commission / AePS settlement) into the Main wallet.
router.post(
  '/sweep',
  validate(sweepSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof sweepSchema>;
    const userId = req.user.id;
    const amountPaise = rupeesToPaise(b.amount);
    const result = await withTransaction(async (client) => {
      await debitSub(client, userId, b.from, amountPaise);
      const newMain = await credit(client, {
        userId,
        amountPaise,
        source: b.from === 'commission' ? 'commission' : 'adjustment',
        description: `Swept ${b.from} wallet to main`,
      });
      // Both are member liabilities: shift from the sub-wallet to main.
      await postJournal(client, {
        source: 'sweep',
        narration: `Sweep ${b.from} -> main`,
        lines: [
          { account: b.from === 'commission' ? 'commission_wallet' : 'settlement_wallet', direction: 'debit', amountPaise, walletUserId: userId },
          { account: 'member_wallet', direction: 'credit', amountPaise, walletUserId: userId },
        ],
      });
      return newMain;
    });
    res.json({ main_balance_paise: result });
  }),
);

// ---- Wallet withdrawal to bank (agent cash-out) ----
const withdrawSchema = z.object({
  amount: z.coerce.number().positive().max(2_000_000),
  account_name: z.string().trim().min(2).max(120),
  account_number: z.string().trim().regex(/^\d{6,20}$/, 'Invalid account number'),
  ifsc: z.string().trim().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC'),
  mode: z.enum(['IMPS', 'NEFT', 'RTGS']).default('IMPS'),
});

router.post(
  '/withdraw',
  validate(withdrawSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof withdrawSchema>;
    const w = await requestWithdrawal(req.user.id, {
      amountPaise: rupeesToPaise(b.amount),
      accountName: b.account_name,
      accountNumber: b.account_number,
      ifsc: b.ifsc.toUpperCase(),
      mode: b.mode,
    });
    res.status(201).json({ withdrawal: w });
  }),
);

router.get(
  '/withdrawals',
  validate(pageSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { limit, offset } = req.query as unknown as { limit: number; offset: number };
    const { rows } = await query(
      'SELECT * FROM wallet_withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [req.user.id, limit, offset],
    );
    res.json({ items: rows, limit, offset });
  }),
);

router.get(
  '/ledger',
  validate(pageSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { limit, offset } = req.query as unknown as { limit: number; offset: number };
    const items = await listLedger(req.user.id, limit, offset);
    res.json({ items, limit, offset });
  }),
);

export default router;
