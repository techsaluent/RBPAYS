import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';
import { paiseToRupees } from '../../utils/money';
import { receiptData, receiptHtml } from './receipt';

const router = Router();
router.use(requireAuth);

const DETAIL_TABLE: Record<string, string> = {
  dmt: 'dmt_transactions',
  payout: 'payout_transactions',
  bbps: 'bbps_transactions',
  recharge: 'recharge_transactions',
  aeps: 'aeps_transactions',
  cms: 'cms_transactions',
  card_swipe: 'card_swipe_transactions',
  upi: 'upi_transactions',
  matm: 'matm_transactions',
  aadhaar_pay: 'aadhaar_pay_transactions',
  pan_card: 'pan_card_transactions',
  wallet_transfer: 'wallet_transfers',
  travel: 'travel_transactions',
  insurance: 'insurance_transactions',
  payment_gateway: 'pg_orders',
};

function serialize(t: Record<string, unknown>) {
  return {
    ...t,
    amount_paise: Number(t.amount_paise as string),
    charge_paise: Number(t.charge_paise as string),
    commission_paise: Number(t.commission_paise as string),
    net_paise: Number(t.net_paise as string),
    amount: paiseToRupees(t.amount_paise as string),
    charge: paiseToRupees(t.charge_paise as string),
    commission: paiseToRupees(t.commission_paise as string),
    net: paiseToRupees(t.net_paise as string),
  };
}

const listSchema = z.object({
  service: z
    .enum([
      'dmt', 'bbps', 'recharge', 'payout', 'aeps', 'cms', 'card_swipe',
      'upi', 'matm', 'aadhaar_pay', 'pan_card', 'wallet_transfer',
      'travel', 'insurance', 'payment_gateway',
    ])
    .optional(),
  status: z.enum(['pending', 'success', 'failed', 'refunded']).optional(),
  direction: z.enum(['debit', 'credit']).optional(),
  user_id: z.string().uuid().optional(), // admin only
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// Unified transaction history across every service.
router.get(
  '/',
  validate(listSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const q = req.query as unknown as z.infer<typeof listSchema>;
    // Admins may query any user; everyone else is scoped to themselves.
    const targetUser = req.user.role === 'admin' && q.user_id ? q.user_id : req.user.id;
    const { rows } = await query(
      `SELECT * FROM transactions
        WHERE user_id = $1
          AND ($2::text IS NULL OR service = $2)
          AND ($3::text IS NULL OR status = $3)
          AND ($4::text IS NULL OR direction = $4)
        ORDER BY created_at DESC
        LIMIT $5 OFFSET $6`,
      [targetUser, q.service ?? null, q.status ?? null, q.direction ?? null, q.limit, q.offset],
    );
    res.json({ items: rows.map(serialize), limit: q.limit, offset: q.offset });
  }),
);

// Headline stats for the signed-in member's dashboard tiles. Day/month
// boundaries use India Standard Time so "today" matches the operator's day.
router.get(
  '/stats/summary',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rows } = await query<Record<string, string>>(
      `SELECT
          COUNT(*) AS total_count,
          COUNT(*) FILTER (WHERE status = 'success') AS success_count,
          COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
          COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
          COALESCE(SUM(amount_paise) FILTER (WHERE status = 'success'), 0) AS success_amount,
          COALESCE(SUM(commission_paise) FILTER (WHERE status = 'success'), 0) AS commission_amount,
          COUNT(*) FILTER (
            WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
          ) AS today_count,
          COALESCE(SUM(amount_paise) FILTER (
            WHERE status = 'success'
              AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
          ), 0) AS today_amount,
          COALESCE(SUM(amount_paise) FILTER (
            WHERE status = 'success'
              AND date_trunc('month', created_at AT TIME ZONE 'Asia/Kolkata')
                  = date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')
          ), 0) AS month_amount
        FROM transactions
        WHERE user_id = $1`,
      [req.user.id],
    );
    const r = rows[0];
    const n = (k: string) => Number(r[k] ?? 0);
    const total = n('total_count');
    const success = n('success_count');
    res.json({
      total_count: total,
      success_count: success,
      failed_count: n('failed_count'),
      pending_count: n('pending_count'),
      success_rate: total ? Math.round((success / total) * 100) : 0,
      success_amount_paise: n('success_amount'),
      commission_amount_paise: n('commission_amount'),
      today_count: n('today_count'),
      today_amount_paise: n('today_amount'),
      month_amount_paise: n('month_amount'),
    });
  }),
);

/** Load a transaction the caller may view (own, or any for admin). */
async function loadOwned(req: Request): Promise<Record<string, unknown>> {
  if (!req.user) throw ApiError.unauthorized();
  const { rows } = await query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
  const txn = rows[0];
  if (!txn) throw ApiError.notFound('Transaction not found');
  if (req.user.role !== 'admin' && txn.user_id !== req.user.id) {
    throw ApiError.forbidden('Not your transaction');
  }
  return txn;
}

router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const txn = await loadOwned(req);
    res.json({ transaction: serialize(txn) });
  }),
);

// Printable receipt — HTML by default, or ?format=json for structured data.
router.get(
  '/:id/receipt',
  asyncHandler(async (req: Request, res: Response) => {
    const txn = await loadOwned(req);
    const table = DETAIL_TABLE[txn.service as string];
    const detail = table
      ? (await query(`SELECT * FROM ${table} WHERE id = $1`, [txn.service_txn_id])).rows[0] ?? {}
      : {};
    const userRes = await query<{ full_name: string; phone: string }>(
      'SELECT full_name, phone FROM users WHERE id = $1',
      [txn.user_id],
    );
    const user = userRes.rows[0] ?? { full_name: '-', phone: '-' };

    // Statutory tax breakdown recorded against this transaction.
    const [tdsRes, gstRes, brandRes] = await Promise.all([
      query<{ section: string; gross_paise: string; rate_bps: number; tds_paise: string }>(
        'SELECT section, gross_paise, rate_bps, tds_paise FROM tds_records WHERE service_txn_id = $1 ORDER BY section',
        [txn.service_txn_id],
      ),
      query<{ base: string; cgst: string; sgst: string; igst: string }>(
        `SELECT COALESCE(SUM(taxable_base_paise),0) base, COALESCE(SUM(cgst_paise),0) cgst,
                COALESCE(SUM(sgst_paise),0) sgst, COALESCE(SUM(igst_paise),0) igst
           FROM gst_invoices WHERE service_txn_id = $1`,
        [txn.service_txn_id],
      ),
      query<{ value: string }>("SELECT value FROM site_settings WHERE key = 'brand_name'"),
    ]);
    const tax = {
      tds: tdsRes.rows.map((t) => ({
        section: t.section,
        gross_paise: Number(t.gross_paise),
        rate_bps: t.rate_bps,
        tds_paise: Number(t.tds_paise),
      })),
      gst: Number(gstRes.rows[0]?.base ?? '0') > 0
        ? {
            base_paise: Number(gstRes.rows[0].base),
            cgst_paise: Number(gstRes.rows[0].cgst),
            sgst_paise: Number(gstRes.rows[0].sgst),
            igst_paise: Number(gstRes.rows[0].igst),
          }
        : null,
    };
    const brand = brandRes.rows[0]?.value || 'TutiPays';

    if (req.query.format === 'json') {
      res.json({ receipt: receiptData(txn as never, detail, user, tax) });
      return;
    }
    res.type('html').send(receiptHtml(txn as never, detail, user, tax, brand));
  }),
);

export default router;
