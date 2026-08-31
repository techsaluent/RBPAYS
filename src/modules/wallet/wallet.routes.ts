import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { withTransaction } from '../../../db';
import { rupeesToPaise, paiseToRupees } from '../../utils/money';
import { toCsv, statementHtml } from '../reports/reports.service';
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

// Downloadable wallet passbook (CSV or printable HTML), date-ranged.
const passSchema = z.object({
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  format: z.enum(['csv', 'html']).default('html'),
});
router.get(
  '/statement',
  validate(passSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const q = req.query as unknown as z.infer<typeof passSchema>;
    const { rows } = await query<Record<string, string>>(
      `SELECT wt.created_at, wt.direction, wt.source, wt.description, wt.amount_paise, wt.balance_after_paise
         FROM wallet_transactions wt JOIN wallets w ON w.id = wt.wallet_id
        WHERE w.user_id = $1
          AND ($2::timestamptz IS NULL OR wt.created_at >= $2)
          AND ($3::timestamptz IS NULL OR wt.created_at < ($3::timestamptz + interval '1 day'))
        ORDER BY wt.created_at DESC LIMIT 5000`,
      [req.user.id, q.from || null, q.to || null],
    );
    const r = (p: string) => paiseToRupees(p);
    const sign = (d: string) => (d === 'credit' ? '＋' : '－');
    const period = `${q.from || 'start'} to ${q.to || 'today'}`;

    if (q.format === 'csv') {
      const csv = toCsv(
        ['Date', 'Type', 'Source', 'Description', 'Amount', 'Balance'],
        rows.map((t) => [new Date(t.created_at).toISOString(), t.direction, t.source, t.description || '', r(t.amount_paise), r(t.balance_after_paise)]),
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="passbook_${q.from || 'all'}_${q.to || 'now'}.csv"`);
      res.send(csv);
      return;
    }
    res.type('html').send(
      statementHtml({
        title: 'Wallet passbook',
        subtitle: period,
        meta: [['Entries', String(rows.length)]],
        columns: [{ label: 'Date' }, { label: 'Source' }, { label: 'Description' }, { label: 'Amount', align: 'right' }, { label: 'Balance', align: 'right' }],
        rows: rows.map((t) => [
          new Date(t.created_at).toLocaleString('en-IN'), String(t.source).replace(/_/g, ' '), t.description || '',
          `${sign(t.direction)} ₹${r(t.amount_paise)}`, '₹' + r(t.balance_after_paise),
        ]),
      }),
    );
  }),
);

export default router;
