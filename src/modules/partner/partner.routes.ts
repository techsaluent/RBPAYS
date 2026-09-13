import { Request, Response, Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { partnerGate, partnerScope } from '../../middleware/partner';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';
import { getWalletByUser } from '../wallet/wallet.service';

// Re-mounted service routers — the public partner API reuses the exact same
// transaction engine (validation, orchestrator, wallet debit, commissions,
// settlement, failover) as the panel; only the auth surface differs.
import rechargeRouter from '../recharge/recharge.routes';
import dmtRouter from '../dmt/dmt.routes';
import bbpsRouter from '../bbps/bbps.routes';
import payoutRouter from '../payout/payout.routes';

/**
 * Public partner / reseller API. Authenticated by a `pk_` API key that resolves
 * to the owning member; every call runs AS that member (their wallet, their
 * commissions, their upline). The key's scopes gate which services it may call.
 */
const router = Router();
router.use(requireAuth); // resolves the pk_ key -> req.user + req.partner
router.use(partnerGate); // rejects non-partner creds; enforces IP allowlist + rate limit

// Key + account introspection.
router.get(
  '/me',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user || !req.partner) throw ApiError.unauthorized();
    const { rows } = await query<{ full_name: string; username: string | null; role: string }>(
      'SELECT full_name, username, role FROM users WHERE id = $1',
      [req.user.id],
    );
    res.json({
      account: rows[0] ? { name: rows[0].full_name, username: rows[0].username, role: rows[0].role } : null,
      environment: req.partner.environment,
      scopes: req.partner.scopes,
      rate_limit_per_min: req.partner.rateLimitPerMin,
      callback_url: req.partner.callbackUrl,
    });
  }),
);

// Wallet balance / spendable (available = balance − active holds).
router.get(
  '/wallet',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const w = await getWalletByUser(req.user.id);
    res.json({
      currency: w.currency,
      balance: w.balance, balance_paise: w.balance_paise,
      held: w.held, held_paise: w.held_paise,
      available: w.available, available_paise: w.available_paise,
      frozen: w.frozen,
    });
  }),
);

// Transaction status by client reference (idempotency key) — partners poll this
// in addition to receiving the outbound callback.
router.get(
  '/transactions/:reference',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rows } = await query(
      `SELECT reference, service, status, direction,
              amount_paise, charge_paise, commission_paise, net_paise,
              provider, status_message, created_at
         FROM transactions WHERE reference = $1 AND user_id = $2`,
      [req.params.reference, req.user.id],
    );
    if (!rows[0]) throw ApiError.notFound('Transaction not found');
    res.json({ transaction: rows[0] });
  }),
);

// Recent transactions for reconciliation.
router.get(
  '/transactions',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 100);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const { rows } = await query(
      `SELECT reference, service, status, direction, amount_paise, net_paise, provider, created_at
         FROM transactions
        WHERE user_id = $1 AND ($2::text IS NULL OR status = $2::txn_status)
        ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [req.user.id, status, limit, offset],
    );
    res.json({ items: rows, limit, offset });
  }),
);

// Service endpoints — each gated by the key's scope, then handled by the same
// router the panel uses. Adding another service is a single line here.
router.use('/recharge', partnerScope('recharge'), rechargeRouter);
router.use('/dmt', partnerScope('dmt'), dmtRouter);
router.use('/bbps', partnerScope('bbps'), bbpsRouter);
router.use('/payout', partnerScope('payout'), payoutRouter);

export default router;
