import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { staffConsoleGate } from '../../middleware/permission';
import { logAudit } from '../audit/audit.service';
import { refundTransaction, resolvePending } from '../transactions/refund.service';
import { emitEvent } from '../notify/events.service';
import { addMessage, notifyMember } from '../disputes/dispute.service';
import { approveWithdrawal, rejectWithdrawal } from '../withdrawal/withdrawal.service';
import { validate } from '../../middleware/validate';
import { env } from '../../config/env';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query, withTransaction } from '../../../db';
import { rupeesToPaise, bigintToNumber, paiseToRupees } from '../../utils/money';
import { debit, credit } from '../wallet/wallet.service';
import { createMember } from '../members/members.service';
import { usernameSchema } from '../auth/auth.schemas';
import { dashboardStats } from './admin.dashboard';
import { refreshProviderRegistry } from '../../providers/registry';
import { dryRunDynamic, liveTestDynamic } from '../../providers/dynamic';
import { toCsv } from '../reports/reports.service';
import { draftProviderConfig, analyzeDevRequest } from '../ai/ai.service';
import { createDevRequest, listDevRequests, getDevRequest, setPlan, setStatus } from '../devdesk/devdesk.service';
import { postJournal } from '../_shared/ledger';
import { runReconciliation, MisRow } from '../recon/recon.service';
import { assessOnboarding } from '../onboarding/onboarding.service';
import { refreshTaxConfig } from '../tax/tax.config';
import { adminResetPassword } from '../auth/auth.service';
import {
  createPayoutBatch,
  generateBatchFile,
  ingestReverseFeed,
  treasuryBalances,
  treasurySweep,
  BatchRecordInput,
} from '../payout/batchpayout.service';

const router = Router();
router.use(requireAuth, asyncHandler(staffConsoleGate));

const USER_COLUMNS =
  'id, full_name, username, email, phone, role, status, kyc_status, parent_id, commission_plan_id, activated_at, created_at';

// ---------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------
router.get(
  '/dashboard',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await dashboardStats());
  }),
);

// ---- Wallet withdrawals (agent cash-out) — finance review ----
router.get(
  '/withdrawals',
  asyncHandler(async (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const { rows } = await query(
      `SELECT w.*, u.full_name, u.role, u.phone
         FROM wallet_withdrawals w JOIN users u ON u.id = w.user_id
        WHERE ($1::text IS NULL OR w.status = $1)
        ORDER BY w.created_at DESC LIMIT 100`,
      [status],
    );
    res.json({ items: rows });
  }),
);

const withdrawalDecideSchema = z.object({ utr: z.string().trim().max(40).optional(), remarks: z.string().trim().max(200).optional() });

router.post(
  '/withdrawals/:id/approve',
  validate(withdrawalDecideSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof withdrawalDecideSchema>;
    const w = await approveWithdrawal(req.params.id, req.user.id, b.utr, b.remarks);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'withdrawal.paid',
      targetType: 'withdrawal', targetId: req.params.id, detail: { utr: b.utr ?? null, remarks: b.remarks ?? null, amount_paise: Number(w.amount_paise) } });
    res.json({ withdrawal: w });
  }),
);

router.post(
  '/withdrawals/:id/reject',
  validate(withdrawalDecideSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof withdrawalDecideSchema>;
    const w = await rejectWithdrawal(req.params.id, req.user.id, b.remarks);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'withdrawal.reject',
      targetType: 'withdrawal', targetId: req.params.id, detail: { remarks: b.remarks ?? null } });
    res.json({ withdrawal: w });
  }),
);

// Activity audit log (super admin only — staff hit the fail-closed gate).
const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  action: z.string().trim().max(60).optional(),
  actor_id: z.string().uuid().optional(),
});
router.get(
  '/audit',
  validate(auditQuerySchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof auditQuerySchema>;
    const { rows } = await query(
      `SELECT a.*, u.full_name AS actor_name
         FROM admin_audit_log a
         LEFT JOIN users u ON u.id = a.actor_id
        WHERE ($1::text IS NULL OR a.action = $1)
          AND ($2::uuid IS NULL OR a.actor_id = $2)
        ORDER BY a.created_at DESC
        LIMIT $3 OFFSET $4`,
      [q.action ?? null, q.actor_id ?? null, q.limit, q.offset],
    );
    res.json({ items: rows, limit: q.limit, offset: q.offset });
  }),
);

// ---------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------
const listUsersSchema = z.object({
  role: z.enum(['user', 'retailer', 'distributor', 'master_distributor', 'admin', 'agent']).optional(),
  status: z.enum(['active', 'suspended', 'blocked']).optional(),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get(
  '/users',
  validate(listUsersSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof listUsersSchema>;
    const like = q.q ? `%${q.q}%` : null;
    const { rows } = await query(
      `SELECT ${USER_COLUMNS} FROM users
        WHERE ($1::text IS NULL OR role = $1)
          AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR full_name ILIKE $3 OR email ILIKE $3 OR phone ILIKE $3 OR username ILIKE $3)
        ORDER BY created_at DESC
        LIMIT $4 OFFSET $5`,
      [q.role ?? null, q.status ?? null, like, q.limit, q.offset],
    );
    res.json({ items: rows, limit: q.limit, offset: q.offset });
  }),
);

router.get(
  '/users/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const user = await query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [req.params.id]);
    if (!user.rows[0]) throw ApiError.notFound('User not found');
    const [wallet, services] = await Promise.all([
      query('SELECT balance_paise, currency FROM wallets WHERE user_id = $1', [req.params.id]),
      query('SELECT service_code, active, activated_at FROM user_services WHERE user_id = $1', [req.params.id]),
    ]);
    res.json({ user: user.rows[0], wallet: wallet.rows[0] ?? null, services: services.rows });
  }),
);

const createUserSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  username: usernameSchema.optional(),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
  password: z.string().min(8).max(128),
  role: z.enum(['retailer', 'distributor', 'master_distributor']),
  commission_plan_id: z.string().uuid().optional(),
});

// Admin onboards a member (admin is the parent; any member role allowed).
router.post(
  '/users',
  validate(createUserSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof createUserSchema>;
    const member = await createMember({ parentId: req.user.id, parentRole: 'admin', ...b });
    res.status(201).json({ member });
  }),
);

const statusSchema = z.object({ status: z.enum(['active', 'suspended', 'blocked']) });

// Activate / suspend / block an account.
router.patch(
  '/users/:id/status',
  validate(statusSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { status } = req.body as z.infer<typeof statusSchema>;
    const { rows } = await query(
      `UPDATE users
          SET status = $1, activated_at = CASE WHEN $1 = 'active' AND activated_at IS NULL THEN now() ELSE activated_at END
        WHERE id = $2 RETURNING ${USER_COLUMNS}`,
      [status, req.params.id],
    );
    if (!rows[0]) throw ApiError.notFound('User not found');
    if (req.user) await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'user.status',
      targetType: 'user', targetId: req.params.id, detail: { status } });
    res.json({ user: rows[0] });
  }),
);

const resetPwSchema = z.object({ new_password: z.string().min(8).max(128) });

// Admin resets a member's password (immediate; revokes their sessions).
router.post(
  '/users/:id/reset-password',
  validate(resetPwSchema),
  asyncHandler(async (req: Request, res: Response) => {
    await adminResetPassword(req.params.id, req.body.new_password);
    res.json({ message: 'Password reset' });
  }),
);

// Incoming provider callbacks / webhooks log.
router.get(
  '/provider-events',
  validate(z.object({
    provider: z.string().trim().max(40).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }), 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { provider?: string; limit: number };
    const { rows } = await query(
      `SELECT id, provider, event_type, external_id, processed, received_at
         FROM provider_events
        WHERE ($1::text IS NULL OR provider = $1)
        ORDER BY received_at DESC LIMIT $2`,
      [q.provider ?? null, q.limit],
    );
    res.json({ items: rows });
  }),
);

// ---- Transaction ops: refund + pending resolution ------------------------
const txnDecisionSchema = z.object({ remark: z.string().trim().min(1).max(200) });
const resolveSchema = z.object({
  decision: z.enum(['success', 'failed']),
  remark: z.string().trim().min(1).max(200),
});

// Refund a successful debit-flow transaction (credits payer, claws back commission).
router.post(
  '/transactions/:id/refund',
  validate(txnDecisionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const txn = await refundTransaction(req.params.id, req.body.remark);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'txn.refund',
      targetType: 'transaction', targetId: req.params.id, detail: { remark: req.body.remark } });
    res.json({ transaction: txn });
  }),
);

// Resolve a stuck pending transaction to success or failed.
router.post(
  '/transactions/:id/resolve',
  validate(resolveSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const txn = await resolvePending(req.params.id, req.body.decision, req.body.remark);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'txn.resolve',
      targetType: 'transaction', targetId: req.params.id, detail: { decision: req.body.decision, remark: req.body.remark } });
    res.json({ transaction: txn });
  }),
);

// Ops list / search: by status and/or platform reference id (partial match).
router.get(
  '/transactions',
  validate(z.object({
    status: z.enum(['pending', 'failed', 'success', 'refunded']).optional(),
    reference: z.string().trim().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }), 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { status?: string; reference?: string; limit: number };
    const { rows } = await query(
      `SELECT t.*, u.full_name AS user_name
         FROM transactions t LEFT JOIN users u ON u.id = t.user_id
        WHERE ($1::text IS NULL OR t.status = $1)
          AND ($2::text IS NULL OR t.reference ILIKE '%' || $2 || '%')
        ORDER BY t.created_at DESC LIMIT $3`,
      [q.status ?? null, q.reference ?? null, q.limit],
    );
    res.json({ items: rows });
  }),
);

// ---- Disputes / complaints desk -------------------------------------------
// Ops summary: live counts by status, overdue count, and average resolution
// time — the numbers the disputes desk needs at a glance.
router.get(
  '/disputes-summary',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query<{
      open: string; in_review: string; resolved: string; rejected: string;
      overdue: string; due_soon: string; oldest_open_hours: string | null; avg_resolution_hours: string | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'open')        AS open,
         COUNT(*) FILTER (WHERE status = 'in_review')   AS in_review,
         COUNT(*) FILTER (WHERE status = 'resolved')    AS resolved,
         COUNT(*) FILTER (WHERE status = 'rejected')    AS rejected,
         COUNT(*) FILTER (WHERE status IN ('open','in_review') AND sla_due_at < now())                          AS overdue,
         COUNT(*) FILTER (WHERE status IN ('open','in_review') AND sla_due_at >= now() AND sla_due_at < now() + interval '2 hours') AS due_soon,
         MAX(EXTRACT(EPOCH FROM (now() - created_at)) / 3600) FILTER (WHERE status IN ('open','in_review'))       AS oldest_open_hours,
         AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600) FILTER (WHERE resolved_at IS NOT NULL)        AS avg_resolution_hours
       FROM disputes`,
    );
    const r = rows[0];
    res.json({
      open: Number(r.open), in_review: Number(r.in_review), resolved: Number(r.resolved), rejected: Number(r.rejected),
      overdue: Number(r.overdue), due_soon: Number(r.due_soon),
      oldest_open_hours: r.oldest_open_hours != null ? Math.round(Number(r.oldest_open_hours) * 10) / 10 : null,
      avg_resolution_hours: r.avg_resolution_hours != null ? Math.round(Number(r.avg_resolution_hours) * 10) / 10 : null,
    });
  }),
);

router.get(
  '/disputes',
  validate(z.object({
    status: z.enum(['open', 'in_review', 'resolved', 'rejected']).optional(),
    q: z.string().trim().max(64).optional(), // search by reference or ticket no
    overdue: z.coerce.boolean().optional(),  // only past-SLA, still-open disputes
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }), 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const p = req.query as unknown as { status?: string; q?: string; overdue?: boolean; limit: number };
    const { rows } = await query(
      `SELECT d.*, u.full_name AS raised_by_name, u.phone AS raised_by_phone,
              t.service AS txn_service, t.amount_paise AS txn_amount_paise, t.status AS txn_status,
              (d.status IN ('open','in_review') AND d.sla_due_at < now()) AS overdue,
              EXTRACT(EPOCH FROM (d.sla_due_at - now())) / 3600 AS sla_hours_left
         FROM disputes d
         JOIN users u ON u.id = d.raised_by
         LEFT JOIN transactions t ON t.id = d.transaction_id
        WHERE ($1::text IS NULL OR d.status = $1)
          AND ($2::text IS NULL OR d.reference ILIKE '%' || $2 || '%' OR d.ticket_no ILIKE '%' || $2 || '%')
          AND ($3::boolean IS NOT TRUE OR (d.status IN ('open','in_review') AND d.sla_due_at < now()))
        -- Unresolved first, then most-overdue first, then newest.
        ORDER BY (d.status IN ('open','in_review')) DESC,
                 CASE WHEN d.status IN ('open','in_review') THEN d.sla_due_at END ASC NULLS LAST,
                 d.created_at DESC
        LIMIT $4`,
      [p.status ?? null, p.q ?? null, p.overdue ?? null, p.limit],
    );
    res.json({ items: rows });
  }),
);

// Full dispute view + thread (staff).
router.get(
  '/disputes/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { rows } = await query(
      `SELECT d.*, u.full_name AS raised_by_name, u.phone AS raised_by_phone
         FROM disputes d JOIN users u ON u.id = d.raised_by WHERE d.id = $1`,
      [req.params.id],
    );
    if (!rows[0]) throw ApiError.notFound('Dispute not found');
    const msgs = await query('SELECT * FROM dispute_messages WHERE dispute_id = $1 ORDER BY created_at', [req.params.id]);
    res.json({ dispute: rows[0], messages: msgs.rows });
  }),
);

// Printable dispute receipt (HTML) for staff.
router.get(
  '/disputes/:id/receipt',
  asyncHandler(async (req: Request, res: Response) => {
    const { disputeReceiptHtml } = await import('../disputes/dispute.service');
    const { rows } = await query('SELECT * FROM disputes WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw ApiError.notFound('Dispute not found');
    const msgs = await query('SELECT * FROM dispute_messages WHERE dispute_id = $1 ORDER BY created_at', [req.params.id]);
    const brand = await query<{ value: string }>("SELECT value FROM site_settings WHERE key = 'brand_name'");
    res.type('html').send(disputeReceiptHtml(rows[0], msgs.rows, brand.rows[0]?.value || 'TutiPays'));
  }),
);

// Staff reply on a dispute thread (notifies the member by SMS).
router.post(
  '/disputes/:id/messages',
  validate(z.object({ message: z.string().trim().min(1).max(1000) })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const d = await query<{ ticket_no: string }>('SELECT ticket_no FROM disputes WHERE id = $1', [req.params.id]);
    if (!d.rows[0]) throw ApiError.notFound('Dispute not found');
    const role = req.user.role === 'admin' ? 'admin' : 'staff';
    const msg = await addMessage(req.params.id, req.user.id, role, 'comment', req.body.message);
    await notifyMember(req.params.id, `Update on your dispute ${d.rows[0].ticket_no}: ${req.body.message}`);
    emitEvent('dispute.message', { dispute_id: req.params.id, by: role });
    res.status(201).json({ message: msg });
  }),
);

const disputeDecisionSchema = z.object({
  status: z.enum(['in_review', 'resolved', 'rejected']),
  resolution: z.string().trim().min(1).max(1000),
  refund: z.boolean().default(false), // resolve as a refund -> credit the payer
});
router.post(
  '/disputes/:id/resolve',
  validate(disputeDecisionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof disputeDecisionSchema>;
    const terminal = b.status === 'resolved' || b.status === 'rejected';

    const cur = await query<{ id: string; transaction_id: string | null; ticket_no: string }>(
      'SELECT id, transaction_id, ticket_no FROM disputes WHERE id = $1',
      [req.params.id],
    );
    if (!cur.rows[0]) throw ApiError.notFound('Dispute not found');

    // Resolve-as-refund: move the money first (must succeed to mark resolved).
    let refundNote = '';
    if (b.refund && b.status === 'resolved') {
      if (!cur.rows[0].transaction_id) throw ApiError.badRequest('This dispute has no linked transaction to refund');
      await refundTransaction(cur.rows[0].transaction_id, `Dispute ${cur.rows[0].ticket_no}: ${b.resolution}`);
      refundNote = ' Amount refunded to wallet.';
      await addMessage(req.params.id, req.user.id, req.user.role === 'admin' ? 'admin' : 'staff', 'refund', 'Refund issued — wallet credited.');
    }

    const { rows } = await query(
      `UPDATE disputes
          SET status = $1, resolution = $2, assigned_to = $3,
              resolved_by = CASE WHEN $4 THEN $3 ELSE resolved_by END,
              resolved_at = CASE WHEN $4 THEN now() ELSE resolved_at END
        WHERE id = $5 RETURNING *`,
      [b.status, b.resolution, req.user.id, terminal, req.params.id],
    );
    const role = req.user.role === 'admin' ? 'admin' : 'staff';
    await addMessage(req.params.id, req.user.id, role, 'status_change', b.resolution, b.status);
    await notifyMember(req.params.id, `Your dispute ${rows[0].ticket_no} is now ${b.status}. ${b.resolution}${refundNote}`);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'dispute.' + b.status,
      targetType: 'dispute', targetId: req.params.id, detail: { resolution: b.resolution, refund: b.refund, reference: rows[0].reference } });
    emitEvent('dispute.' + b.status, { ticket_no: rows[0].ticket_no, reference: rows[0].reference, resolution: b.resolution, refund: b.refund });
    res.json({ dispute: rows[0] });
  }),
);

// ---- Wallet holds (lien / blocked amount) --------------------------------
const holdSchema = z.object({
  amount: z.coerce.number().positive().max(10000000), // rupees
  reason: z.string().trim().max(200).optional(),
});

// List a user's holds (active + released) + the current blocked total.
router.get(
  '/users/:id/holds',
  asyncHandler(async (req: Request, res: Response) => {
    const { rows } = await query(
      `SELECT h.*, pb.full_name AS placed_by_name, rb.full_name AS released_by_name
         FROM wallet_holds h
         LEFT JOIN users pb ON pb.id = h.placed_by
         LEFT JOIN users rb ON rb.id = h.released_by
        WHERE h.user_id = $1
        ORDER BY h.created_at DESC`,
      [req.params.id],
    );
    const active = rows.filter((r) => r.status === 'active').reduce((s, r) => s + Number(r.amount_paise), 0);
    res.json({ items: rows, held_paise: active });
  }),
);

// Place a hold on a user's wallet.
router.post(
  '/users/:id/holds',
  validate(holdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof holdSchema>;
    const user = await query('SELECT 1 FROM users WHERE id = $1', [req.params.id]);
    if (!user.rowCount) throw ApiError.notFound('User not found');
    const { rows } = await query(
      `INSERT INTO wallet_holds (user_id, amount_paise, reason, placed_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, rupeesToPaise(b.amount), b.reason ?? null, req.user.id],
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'hold.place',
      targetType: 'user', targetId: req.params.id, detail: { amount_paise: rupeesToPaise(b.amount), reason: b.reason ?? null } });
    res.status(201).json({ hold: rows[0] });
  }),
);

// Release a hold (unblock the funds).
router.post(
  '/users/:id/holds/:holdId/release',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rows } = await query(
      `UPDATE wallet_holds SET status = 'released', released_by = $1, released_at = now()
        WHERE id = $2 AND user_id = $3 AND status = 'active' RETURNING *`,
      [req.user.id, req.params.holdId, req.params.id],
    );
    if (!rows[0]) throw ApiError.notFound('Active hold not found');
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'hold.release',
      targetType: 'user', targetId: req.params.id, detail: { hold_id: req.params.holdId } });
    res.json({ hold: rows[0] });
  }),
);

const planSchema = z.object({ commission_plan_id: z.string().uuid().nullable() });

// Assign a commission plan to a user.
router.patch(
  '/users/:id/plan',
  validate(planSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { commission_plan_id } = req.body as z.infer<typeof planSchema>;
    const { rows } = await query(
      `UPDATE users SET commission_plan_id = $1 WHERE id = $2 RETURNING ${USER_COLUMNS}`,
      [commission_plan_id, req.params.id],
    );
    if (!rows[0]) throw ApiError.notFound('User not found');
    res.json({ user: rows[0] });
  }),
);

const userServiceSchema = z.object({
  service_code: z.string().trim().min(1).max(40),
  active: z.boolean().default(true),
  // If activating and the service has an activation charge, debit the wallet.
  apply_activation_fee: z.boolean().default(false),
});

// Activate / deactivate a service for a user (optionally charging the fee).
router.post(
  '/users/:id/services',
  validate(userServiceSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof userServiceSchema>;
    const userId = req.params.id;

    const result = await withTransaction(async (client) => {
      const svc = await client.query<{ activation_charge_paise: string; enabled: boolean }>(
        'SELECT activation_charge_paise, enabled FROM services WHERE code = $1',
        [b.service_code],
      );
      if (!svc.rows[0]) throw ApiError.notFound('Service not found');

      const userExists = await client.query('SELECT 1 FROM users WHERE id = $1', [userId]);
      if (!userExists.rowCount) throw ApiError.notFound('User not found');

      const { rows } = await client.query(
        `INSERT INTO user_services (user_id, service_code, active)
         VALUES ($1,$2,$3)
         ON CONFLICT (user_id, service_code) DO UPDATE SET active = EXCLUDED.active
         RETURNING *`,
        [userId, b.service_code, b.active],
      );

      let charged = 0;
      const fee = Number(svc.rows[0].activation_charge_paise);
      if (b.active && b.apply_activation_fee && fee > 0) {
        await debit(client, {
          userId,
          amountPaise: fee,
          source: 'activation_fee',
          description: `Activation fee for ${b.service_code}`,
        });
        charged = fee;
      }
      return { user_service: rows[0], charged_paise: charged };
    });

    res.json(result);
  }),
);

// ---------------------------------------------------------------------
// Services catalogue
// ---------------------------------------------------------------------
router.get(
  '/services',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query('SELECT * FROM services ORDER BY code');
    res.json({ items: rows });
  }),
);

const serviceUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  activation_charge: z.coerce.number().min(0).optional(), // rupees
  min_commission: z.coerce.number().min(0).optional(),    // rupees — floor per txn
  max_commission: z.coerce.number().min(0).optional(),    // rupees — ceiling per txn
});

router.patch(
  '/services/:code',
  validate(serviceUpdateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof serviceUpdateSchema>;
    if (
      b.min_commission !== undefined &&
      b.max_commission !== undefined &&
      b.min_commission > b.max_commission
    ) {
      throw ApiError.badRequest('min_commission cannot exceed max_commission');
    }
    const { rows } = await query(
      `UPDATE services
          SET enabled = COALESCE($1, enabled),
              activation_charge_paise = COALESCE($2, activation_charge_paise),
              min_commission_paise = COALESCE($3, min_commission_paise),
              max_commission_paise = COALESCE($4, max_commission_paise)
        WHERE code = $5 RETURNING *`,
      [
        b.enabled ?? null,
        b.activation_charge === undefined ? null : rupeesToPaise(b.activation_charge),
        b.min_commission === undefined ? null : rupeesToPaise(b.min_commission),
        b.max_commission === undefined ? null : rupeesToPaise(b.max_commission),
        req.params.code,
      ],
    );
    if (!rows[0]) throw ApiError.notFound('Service not found');
    res.json({ service: rows[0] });
  }),
);

// ---------------------------------------------------------------------
// Commission plans + rules
// ---------------------------------------------------------------------
router.get(
  '/commission-plans',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query('SELECT * FROM commission_plans ORDER BY created_at');
    res.json({ items: rows });
  }),
);

const planCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional(),
  is_default: z.boolean().default(false),
});

router.post(
  '/commission-plans',
  validate(planCreateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof planCreateSchema>;
    const plan = await withTransaction(async (client) => {
      if (b.is_default) {
        await client.query('UPDATE commission_plans SET is_default = false WHERE is_default = true');
      }
      const { rows } = await client.query(
        'INSERT INTO commission_plans (name, description, is_default) VALUES ($1,$2,$3) RETURNING *',
        [b.name, b.description ?? null, b.is_default],
      );
      return rows[0];
    });
    res.status(201).json({ plan });
  }),
);

// Rename a plan and/or make it the default (unsets any other default).
const planUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(300).optional(),
  is_default: z.boolean().optional(),
});
router.patch(
  '/commission-plans/:id',
  validate(planUpdateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof planUpdateSchema>;
    const plan = await withTransaction(async (client) => {
      const cur = await client.query('SELECT 1 FROM commission_plans WHERE id = $1', [req.params.id]);
      if (!cur.rowCount) throw ApiError.notFound('Plan not found');
      if (b.is_default === true) {
        await client.query('UPDATE commission_plans SET is_default = false WHERE is_default = true AND id <> $1', [req.params.id]);
      }
      const { rows } = await client.query(
        `UPDATE commission_plans SET
            name = COALESCE($1, name), description = COALESCE($2, description),
            is_default = COALESCE($3, is_default), updated_at = now()
          WHERE id = $4 RETURNING *`,
        [b.name ?? null, b.description ?? null, b.is_default ?? null, req.params.id],
      );
      return rows[0];
    });
    res.json({ plan });
  }),
);

// Delete a plan (not the default). Members on it fall back to the default
// (users.commission_plan_id is ON DELETE SET NULL); its rules cascade.
router.delete(
  '/commission-plans/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const cur = await query<{ is_default: boolean }>('SELECT is_default FROM commission_plans WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) throw ApiError.notFound('Plan not found');
    if (cur.rows[0].is_default) throw ApiError.badRequest('Cannot delete the default plan — set another as default first.');
    await query('DELETE FROM commission_plans WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  }),
);

router.get(
  '/commission-plans/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const plan = await query('SELECT * FROM commission_plans WHERE id = $1', [req.params.id]);
    if (!plan.rows[0]) throw ApiError.notFound('Plan not found');
    const rules = await query(
      'SELECT * FROM commission_rules WHERE plan_id = $1 ORDER BY service_code, min_amount_paise',
      [req.params.id],
    );
    res.json({ plan: plan.rows[0], rules: rules.rows });
  }),
);

const cvType = z.enum(['flat', 'percent']);
const ruleSchema = z.object({
  service_code: z.string().trim().min(1).max(40),
  provider_id: z.string().uuid().optional(), // omit = default rule for the service
  min_amount: z.coerce.number().min(0).default(0), // rupees
  max_amount: z.coerce.number().min(0).optional(), // rupees; omit = no upper bound
  charge_type: cvType.default('flat'),
  charge_value: z.coerce.number().min(0).default(0),
  retailer_type: cvType.default('flat'),
  retailer_value: z.coerce.number().min(0).default(0),
  distributor_type: cvType.default('flat'),
  distributor_value: z.coerce.number().min(0).default(0),
  master_distributor_type: cvType.default('flat'),
  master_distributor_value: z.coerce.number().min(0).default(0),
  admin_type: cvType.default('flat'),
  admin_value: z.coerce.number().min(0).default(0),
});

const MAX_BIGINT = '9223372036854775807';

// Add a slab rule to a plan.
router.post(
  '/commission-plans/:id/rules',
  validate(ruleSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof ruleSchema>;
    const plan = await query('SELECT 1 FROM commission_plans WHERE id = $1', [req.params.id]);
    if (!plan.rowCount) throw ApiError.notFound('Plan not found');

    // Enforce the super-admin's per-service commission guardrails. When every
    // level is a flat amount, the total distributed commission is fixed and
    // must fall within [min_commission, max_commission] for the service.
    const svc = await query<{ min_commission_paise: string; max_commission_paise: string }>(
      'SELECT min_commission_paise, max_commission_paise FROM services WHERE code = $1',
      [b.service_code],
    );
    if (!svc.rows[0]) throw ApiError.notFound('Service not found');
    const allFlat =
      b.retailer_type === 'flat' &&
      b.distributor_type === 'flat' &&
      b.master_distributor_type === 'flat' &&
      b.admin_type === 'flat';
    if (allFlat) {
      const totalPaise =
        rupeesToPaise(b.retailer_value) +
        rupeesToPaise(b.distributor_value) +
        rupeesToPaise(b.master_distributor_value) +
        rupeesToPaise(b.admin_value);
      const min = Number(svc.rows[0].min_commission_paise);
      const max = Number(svc.rows[0].max_commission_paise);
      if (totalPaise < min || totalPaise > max) {
        throw ApiError.unprocessable(
          `Total commission ₹${(totalPaise / 100).toLocaleString('en-IN')} is outside the allowed range ` +
            `₹${(min / 100).toLocaleString('en-IN')}–₹${(max / 100).toLocaleString('en-IN')} for ${b.service_code}`,
        );
      }
    }
    const { rows } = await query(
      `INSERT INTO commission_rules
         (plan_id, service_code, provider_id, min_amount_paise, max_amount_paise,
          charge_type, charge_value,
          retailer_type, retailer_value, distributor_type, distributor_value,
          master_distributor_type, master_distributor_value, admin_type, admin_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        req.params.id,
        b.service_code,
        b.provider_id ?? null,
        rupeesToPaise(b.min_amount),
        b.max_amount === undefined ? MAX_BIGINT : rupeesToPaise(b.max_amount),
        b.charge_type, b.charge_value,
        b.retailer_type, b.retailer_value,
        b.distributor_type, b.distributor_value,
        b.master_distributor_type, b.master_distributor_value,
        b.admin_type, b.admin_value,
      ],
    );
    res.status(201).json({ rule: rows[0] });
  }),
);

router.delete(
  '/commission-plans/:id/rules/:ruleId',
  asyncHandler(async (req: Request, res: Response) => {
    const { rowCount } = await query(
      'DELETE FROM commission_rules WHERE id = $1 AND plan_id = $2',
      [req.params.ruleId, req.params.id],
    );
    if (!rowCount) throw ApiError.notFound('Rule not found');
    res.status(204).send();
  }),
);

// ---------------------------------------------------------------------
// Double-entry ledger — chart of accounts + journal (audit view)
// ---------------------------------------------------------------------
router.get(
  '/ledger/accounts',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query('SELECT * FROM chart_of_accounts ORDER BY type, code');
    res.json({ items: rows });
  }),
);

const journalListSchema = z.object({
  source: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get(
  '/ledger/journal',
  validate(journalListSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof journalListSchema>;
    const { rows: entries } = await query<{ id: string }>(
      `SELECT id, reference, source, narration, created_at
         FROM journal_entries
        WHERE ($1::text IS NULL OR source = $1)
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [q.source ?? null, q.limit, q.offset],
    );
    const ids = entries.map((e) => e.id);
    const lines = ids.length
      ? (await query(
          `SELECT jl.entry_id, jl.account_code, jl.direction, jl.amount_paise,
                  jl.wallet_user_id, u.full_name AS wallet_owner
             FROM journal_lines jl
             LEFT JOIN users u ON u.id = jl.wallet_user_id
            WHERE jl.entry_id = ANY($1::uuid[])
            ORDER BY jl.direction DESC`,
          [ids],
        )).rows
      : [];
    const byEntry: Record<string, unknown[]> = {};
    for (const l of lines) {
      const r = l as { entry_id: string; amount_paise: string };
      (byEntry[r.entry_id] ??= []).push({ ...l, amount_paise: bigintToNumber(r.amount_paise), amount: paiseToRupees(r.amount_paise) });
    }
    res.json({
      items: entries.map((e) => ({ ...e, lines: byEntry[e.id] ?? [] })),
      limit: q.limit,
      offset: q.offset,
    });
  }),
);

// ---------------------------------------------------------------------
// Onboarding risk scoring + probation tier promotion
// ---------------------------------------------------------------------
router.post(
  '/onboarding/:userId/assess',
  asyncHandler(async (req: Request, res: Response) => {
    const u = await query('SELECT 1 FROM users WHERE id = $1', [req.params.userId]);
    if (!u.rowCount) throw ApiError.notFound('User not found');
    const score = await assessOnboarding(req.params.userId);
    res.json({ assessment: score });
  }),
);

router.get(
  '/onboarding/:userId',
  asyncHandler(async (req: Request, res: Response) => {
    const { rows } = await query(
      'SELECT * FROM onboarding_assessments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5',
      [req.params.userId],
    );
    res.json({ items: rows });
  }),
);

const promoteSchema = z.object({
  tier: z.enum(['probation', 'full']),
  daily_cashout_cap: z.coerce.number().min(0).optional(), // rupees; override
  daily_dmt_cap: z.coerce.number().min(0).optional(),
});

// Move a member between probation and full tier (and optionally set caps).
router.patch(
  '/users/:id/tier',
  validate(promoteSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof promoteSchema>;
    const { rows } = await query(
      `UPDATE users SET
          tier = $1,
          daily_cashout_cap_paise = COALESCE($2, daily_cashout_cap_paise),
          daily_dmt_cap_paise = COALESCE($3, daily_dmt_cap_paise),
          probation_until = CASE WHEN $1 = 'full' THEN NULL ELSE probation_until END
        WHERE id = $4
        RETURNING id, full_name, role, tier, daily_cashout_cap_paise, daily_dmt_cap_paise`,
      [
        b.tier,
        b.daily_cashout_cap === undefined ? null : rupeesToPaise(b.daily_cashout_cap),
        b.daily_dmt_cap === undefined ? null : rupeesToPaise(b.daily_dmt_cap),
        req.params.id,
      ],
    );
    if (!rows[0]) throw ApiError.notFound('User not found');
    res.json({ user: rows[0] });
  }),
);

// ---------------------------------------------------------------------
// Batch payout engine + treasury
// ---------------------------------------------------------------------
const batchCreateSchema = z.object({
  label: z.string().trim().min(2).max(120),
  records: z.array(z.object({
    user_id: z.string().uuid(),
    amount: z.coerce.number().positive().max(10_000_000),
    beneficiary_name: z.string().trim().min(2).max(120),
    account_number: z.string().trim().regex(/^\d{6,20}$/),
    ifsc: z.string().trim().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/),
  })).min(1).max(5000),
});

router.post(
  '/payout-batches',
  validate(batchCreateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof batchCreateSchema>;
    const records: BatchRecordInput[] = b.records.map((r) => ({
      user_id: r.user_id,
      amount_paise: rupeesToPaise(r.amount),
      beneficiary_name: r.beneficiary_name,
      account_number: r.account_number,
      ifsc: r.ifsc,
    }));
    const summary = await createPayoutBatch(b.label, records, req.user.id);
    res.status(201).json({ summary });
  }),
);

router.get(
  '/payout-batches',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query('SELECT * FROM payout_batches ORDER BY created_at DESC LIMIT 50');
    res.json({ items: rows });
  }),
);

router.get(
  '/payout-batches/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const batch = await query('SELECT * FROM payout_batches WHERE id = $1', [req.params.id]);
    if (!batch.rows[0]) throw ApiError.notFound('Batch not found');
    const records = await query('SELECT * FROM payout_batch_records WHERE batch_id = $1 ORDER BY seq', [req.params.id]);
    res.json({ batch: batch.rows[0], records: records.rows });
  }),
);

router.get(
  '/payout-batches/:id/file',
  asyncHandler(async (req: Request, res: Response) => {
    const file = await generateBatchFile(req.params.id);
    res.type('text/plain').send(file);
  }),
);

const reverseFeedSchema = z.object({
  rows: z.array(z.object({
    record_id: z.string().uuid(),
    status: z.enum(['settled', 'returned']),
    utr: z.string().trim().max(40).optional(),
  })).min(1).max(5000),
});

router.post(
  '/payout-batches/:id/reverse-feed',
  validate(reverseFeedSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof reverseFeedSchema>;
    const result = await ingestReverseFeed(req.params.id, b.rows);
    res.json({ result });
  }),
);

router.get(
  '/treasury/balances',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ items: await treasuryBalances() });
  }),
);

const sweepSchema = z.object({
  from_account: z.string().trim(),
  to_account: z.string().trim(),
  amount: z.coerce.number().positive().max(1_000_000_000),
  utr: z.string().trim().max(40).optional(),
});

router.post(
  '/treasury/sweep',
  validate(sweepSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof sweepSchema>;
    const result = await treasurySweep(b.from_account, b.to_account, rupeesToPaise(b.amount), b.utr);
    res.status(201).json({ sweep: result });
  }),
);

// ---------------------------------------------------------------------
// Reconciliation (bank/switch MIS vs internal ledger)
// ---------------------------------------------------------------------
const reconRunSchema = z.object({
  label: z.string().trim().min(2).max(120),
  rows: z.array(z.object({
    reference: z.string().trim().min(1).max(80),
    bank_status: z.enum(['settled', 'reversed', 'not_found']),
    amount_paise: z.coerce.number().int().min(0).optional(),
    rrn: z.string().trim().max(40).optional(),
  })).min(1).max(5000),
});

router.post(
  '/recon/run',
  validate(reconRunSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof reconRunSchema>;
    const summary = await runReconciliation(b.label, b.rows as MisRow[], req.user.id);
    res.status(201).json({ summary });
  }),
);

router.get(
  '/recon/batches',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query('SELECT * FROM recon_batches ORDER BY created_at DESC LIMIT 50');
    res.json({ items: rows });
  }),
);

// Stale-pending report: transactions the provider never gave a final status for.
router.get(
  '/recon/pending',
  validate(z.object({ older_than_min: z.coerce.number().int().min(0).max(100000).default(120) }), 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const { older_than_min } = req.query as unknown as { older_than_min: number };
    const { listStalePending } = await import('../recon/autoRecon');
    const items = await listStalePending(older_than_min);
    res.json({ older_than_min, count: items.length, items });
  }),
);

// Sweep stale pendings to failed (reverses the debit, refunding the member).
// Guarded: older_than_min must be >= 60 so a hasty small window can't nuke
// transactions that are still legitimately in flight.
router.post(
  '/recon/sweep',
  validate(z.object({
    older_than_min: z.coerce.number().int().min(60).max(100000),
    remark: z.string().trim().min(3).max(200).default('Auto-recon: stale pending swept to failed'),
  })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as { older_than_min: number; remark: string };
    const { sweepStalePending } = await import('../recon/autoRecon');
    const result = await sweepStalePending(b.older_than_min, b.remark);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'recon.sweep',
      targetType: 'recon', targetId: 'pending', detail: { older_than_min: b.older_than_min, swept: result.swept, failed: result.failed } });
    res.json(result);
  }),
);

router.get(
  '/recon/batches/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const batch = await query('SELECT * FROM recon_batches WHERE id = $1', [req.params.id]);
    if (!batch.rows[0]) throw ApiError.notFound('Batch not found');
    const records = await query(
      'SELECT * FROM recon_records WHERE batch_id = $1 ORDER BY match_status, created_at',
      [req.params.id],
    );
    res.json({ batch: batch.rows[0], records: records.rows });
  }),
);

// ---------------------------------------------------------------------
// Maker-checker manual adjustments (dual control)
// ---------------------------------------------------------------------
const adjProposeSchema = z.object({
  target_user_id: z.string().uuid(),
  kind: z.enum(['credit', 'debit', 'clawback']),
  amount: z.coerce.number().positive().max(10_000_000),
  reason: z.string().trim().min(3).max(300),
  reference: z.string().trim().max(80).optional(),
});

// Maker proposes an adjustment (no money moves yet).
router.post(
  '/adjustments',
  validate(adjProposeSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof adjProposeSchema>;
    const tgt = await query('SELECT 1 FROM users WHERE id = $1', [b.target_user_id]);
    if (!tgt.rowCount) throw ApiError.notFound('Target user not found');
    const { rows } = await query(
      `INSERT INTO manual_adjustments (target_user, kind, amount_paise, reason, reference, maker_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.target_user_id, b.kind, rupeesToPaise(b.amount), b.reason, b.reference ?? null, req.user.id],
    );
    res.status(201).json({ adjustment: rows[0] });
  }),
);

router.get(
  '/adjustments',
  asyncHandler(async (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const { rows } = await query(
      `SELECT a.*, u.full_name AS target_name, m.full_name AS maker_name, c.full_name AS checker_name
         FROM manual_adjustments a
         JOIN users u ON u.id = a.target_user
         LEFT JOIN users m ON m.id = a.maker_id
         LEFT JOIN users c ON c.id = a.checker_id
        WHERE ($1::text IS NULL OR a.status = $1)
        ORDER BY a.created_at DESC LIMIT 100`,
      [status],
    );
    res.json({ items: rows });
  }),
);

const adjDecideSchema = z.object({ note: z.string().trim().max(300).optional() });

// Checker approves (must differ from maker) -> applies the wallet + journal.
router.post(
  '/adjustments/:id/approve',
  validate(adjDecideSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const checkerId = req.user.id;
    const { note } = req.body as z.infer<typeof adjDecideSchema>;

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{
        id: string; target_user: string; kind: string; amount_paise: string; status: string; maker_id: string;
      }>('SELECT * FROM manual_adjustments WHERE id = $1 FOR UPDATE', [req.params.id]);
      const a = rows[0];
      if (!a) throw ApiError.notFound('Adjustment not found');
      if (a.status !== 'proposed') throw ApiError.conflict(`Already ${a.status}`);
      if (a.maker_id === checkerId) throw ApiError.forbidden('Maker and checker must be different officers');

      const amt = Number(a.amount_paise);
      let journalRef: string;
      if (a.kind === 'credit') {
        await credit(client, { userId: a.target_user, amountPaise: amt, source: 'adjustment', referenceId: a.id, description: 'Manual credit (approved)' });
        journalRef = await postJournal(client, {
          source: 'adjustment', reference: a.id, narration: 'Manual credit',
          lines: [
            { account: 'float_incentive_expense', direction: 'debit', amountPaise: amt },
            { account: 'member_wallet', direction: 'credit', amountPaise: amt, walletUserId: a.target_user },
          ],
        });
      } else {
        // debit / clawback: pull from the member's main wallet.
        await debit(client, { userId: a.target_user, amountPaise: amt, source: 'adjustment', referenceId: a.id, description: `Manual ${a.kind} (approved)` });
        journalRef = await postJournal(client, {
          source: 'adjustment', reference: a.id, narration: `Manual ${a.kind}`,
          lines: [
            { account: 'member_wallet', direction: 'debit', amountPaise: amt, walletUserId: a.target_user },
            { account: 'platform_margin', direction: 'credit', amountPaise: amt },
          ],
        });
      }
      const upd = await client.query(
        `UPDATE manual_adjustments SET status='approved', checker_id=$1, checker_note=$2, journal_ref=$3, decided_at=now()
          WHERE id=$4 RETURNING *`,
        [checkerId, note ?? null, journalRef, a.id],
      );
      return upd.rows[0];
    });
    await logAudit({ actorId: checkerId, actorRole: req.user.role, action: 'adjustment.approve',
      targetType: 'adjustment', targetId: req.params.id, detail: { note: note ?? null, amount_paise: Number(result.amount_paise), kind: result.kind } });
    res.json({ adjustment: result });
  }),
);

router.post(
  '/adjustments/:id/reject',
  validate(adjDecideSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { note } = req.body as z.infer<typeof adjDecideSchema>;
    const { rows } = await query(
      `UPDATE manual_adjustments SET status='rejected', checker_id=$1, checker_note=$2, decided_at=now()
        WHERE id=$3 AND status='proposed' RETURNING *`,
      [req.user.id, note ?? null, req.params.id],
    );
    if (!rows[0]) throw ApiError.conflict('Adjustment not found or already decided');
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'adjustment.reject',
      targetType: 'adjustment', targetId: req.params.id, detail: { note: note ?? null } });
    res.json({ adjustment: rows[0] });
  }),
);

// ---------------------------------------------------------------------
// Risk & AML — flagged events
// ---------------------------------------------------------------------
const riskListSchema = z.object({
  action: z.enum(['review', 'hold', 'block']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get(
  '/risk-events',
  validate(riskListSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof riskListSchema>;
    const { rows } = await query(
      `SELECT r.id, r.user_id, u.full_name, r.service_code, r.reference, r.kind,
              r.score, r.action, r.detail, r.created_at
         FROM risk_events r LEFT JOIN users u ON u.id = r.user_id
        WHERE ($1::text IS NULL OR r.action = $1)
        ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
      [q.action ?? null, q.limit, q.offset],
    );
    res.json({ items: rows, limit: q.limit, offset: q.offset });
  }),
);

// ---------------------------------------------------------------------
// Website settings + custom pages (branding CMS)
// ---------------------------------------------------------------------
router.get(
  '/site/settings',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query('SELECT key, value, updated_at FROM site_settings ORDER BY key');
    res.json({ items: rows });
  }),
);

const siteSettingsSchema = z.object({
  values: z.record(z.string().max(4000)),
});

// Bulk upsert site settings (brand name, logo, colours, contacts, company).
router.put(
  '/site/settings',
  validate(siteSettingsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof siteSettingsSchema>;
    await withTransaction(async (client) => {
      for (const [key, value] of Object.entries(b.values)) {
        await client.query(
          `INSERT INTO site_settings (key, value) VALUES ($1,$2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [key, value],
        );
      }
    });
    const { rows } = await query('SELECT key, value FROM site_settings ORDER BY key');
    res.json({ items: rows });
  }),
);

router.get(
  '/site/pages',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query('SELECT slug, title, published, sort_order, updated_at FROM site_pages ORDER BY sort_order, title');
    res.json({ items: rows });
  }),
);

router.get(
  '/site/pages/:slug',
  asyncHandler(async (req: Request, res: Response) => {
    const { rows } = await query('SELECT * FROM site_pages WHERE slug = $1', [req.params.slug]);
    if (!rows[0]) throw ApiError.notFound('Page not found');
    res.json({ page: rows[0] });
  }),
);

const pageSchema = z.object({
  slug: z.string().trim().regex(/^[a-z0-9-]{2,60}$/, 'slug: lowercase letters, numbers, hyphens'),
  title: z.string().trim().min(2).max(160),
  content: z.string().max(200000).default(''),
  published: z.boolean().default(true),
  sort_order: z.coerce.number().int().default(0),
});

router.put(
  '/site/pages/:slug',
  validate(pageSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof pageSchema>;
    const { rows } = await query(
      `INSERT INTO site_pages (slug, title, content, published, sort_order)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title, content = EXCLUDED.content,
         published = EXCLUDED.published, sort_order = EXCLUDED.sort_order
       RETURNING slug, title, published, sort_order, updated_at`,
      [req.params.slug, b.title, b.content, b.published, b.sort_order],
    );
    res.json({ page: rows[0] });
  }),
);

router.delete(
  '/site/pages/:slug',
  asyncHandler(async (req: Request, res: Response) => {
    const { rowCount } = await query('DELETE FROM site_pages WHERE slug = $1', [req.params.slug]);
    if (!rowCount) throw ApiError.notFound('Page not found');
    res.status(204).send();
  }),
);

// ---------------------------------------------------------------------
// Platform integrations (SMS / email / OTP / Aadhaar / PAN / penny-drop)
// ---------------------------------------------------------------------
router.get(
  '/integrations',
  asyncHandler(async (_req: Request, res: Response) => {
    // Mask secrets in the list; only report whether they are set.
    const { rows } = await query(
      `SELECT key, label, category, provider, base_url, sender_id, is_active, updated_at,
              (api_key IS NOT NULL AND api_key <> '') AS has_key,
              (api_secret IS NOT NULL AND api_secret <> '') AS has_secret
         FROM platform_integrations ORDER BY category, key`,
    );
    res.json({ items: rows });
  }),
);

const integrationSchema = z.object({
  label: z.string().trim().max(120).optional(),
  category: z.enum(['messaging', 'identity', 'verification', 'other']).optional(),
  provider: z.string().trim().max(80).optional(),
  base_url: z.string().trim().max(300).optional(),
  api_key: z.string().trim().max(600).optional(),
  api_secret: z.string().trim().max(600).optional(),
  sender_id: z.string().trim().max(120).optional(),
  extra: z.record(z.any()).optional(),
  is_active: z.boolean().optional(),
});

// Upsert an integration's config + credentials by key.
router.put(
  '/integrations/:key',
  validate(integrationSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof integrationSchema>;
    const { rows } = await query(
      `INSERT INTO platform_integrations (key, label, category, provider, base_url, api_key, api_secret, sender_id, extra, is_active)
       VALUES ($1, COALESCE($2,$1), COALESCE($3,'other'), $4,$5,$6,$7,$8, COALESCE($9,'{}'::jsonb), COALESCE($10,false))
       ON CONFLICT (key) DO UPDATE SET
         label = COALESCE($2, platform_integrations.label),
         category = COALESCE($3, platform_integrations.category),
         provider = COALESCE($4, platform_integrations.provider),
         base_url = COALESCE($5, platform_integrations.base_url),
         api_key = COALESCE($6, platform_integrations.api_key),
         api_secret = COALESCE($7, platform_integrations.api_secret),
         sender_id = COALESCE($8, platform_integrations.sender_id),
         extra = COALESCE($9, platform_integrations.extra),
         is_active = COALESCE($10, platform_integrations.is_active)
       RETURNING key, label, category, provider, base_url, sender_id, is_active, updated_at`,
      [req.params.key, b.label ?? null, b.category ?? null, b.provider ?? null, b.base_url ?? null,
       b.api_key ?? null, b.api_secret ?? null, b.sender_id ?? null,
       b.extra === undefined ? null : JSON.stringify(b.extra), b.is_active ?? null],
    );
    res.json({ integration: rows[0] });
  }),
);

// Send a test message through a messaging integration to confirm it works.
const testMsgSchema = z.object({
  key: z.enum(['sms', 'otp', 'whatsapp', 'email']),
  to: z.string().trim().min(3).max(200), // phone for sms/whatsapp, email for email
});
router.post(
  '/integrations/test',
  validate(testMsgSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof testMsgSchema>;
    const { sendSms, sendWhatsApp, sendEmail } = await import('../notify/notify.service');
    const text = 'TutiPays test message — your integration is working. 🎉';
    let ok = false;
    if (b.key === 'sms' || b.key === 'otp') ok = await sendSms(b.to, text);
    else if (b.key === 'whatsapp') ok = await sendWhatsApp(b.to, text);
    else ok = await sendEmail(b.to, 'TutiPays test message', text);
    res.json({
      ok,
      message: ok
        ? 'Sent — check the destination. (A tolerant gateway may report success even on a bad number; confirm receipt.)'
        : 'Not sent — the integration is inactive or misconfigured. Set base URL + keys and mark it active, then retry.',
    });
  }),
);

// ---------------------------------------------------------------------
// Statutory tax — verify PANs, view TDS (194H/194N) and GST records
// ---------------------------------------------------------------------
const taxVerifySchema = z.object({
  pan_valid: z.boolean().optional(),
  is_206ab_non_filer: z.boolean().optional(),
});

// Mark a member's PAN verified / 206AB status (drives their TDS rate).
router.patch(
  '/tax/:userId',
  validate(taxVerifySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof taxVerifySchema>;
    const { rows } = await query(
      `INSERT INTO tax_profiles (user_id, pan_valid, is_206ab_non_filer)
       VALUES ($1, COALESCE($2,false), COALESCE($3,false))
       ON CONFLICT (user_id) DO UPDATE SET
         pan_valid = COALESCE($2, tax_profiles.pan_valid),
         is_206ab_non_filer = COALESCE($3, tax_profiles.is_206ab_non_filer)
       RETURNING *`,
      [req.params.userId, b.pan_valid ?? null, b.is_206ab_non_filer ?? null],
    );
    res.json({ profile: rows[0] });
  }),
);

// Editable tax rates + caps (super admin).
router.get(
  '/tax-config',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query('SELECT code, label, rate_bps, max_amount_paise, enabled, updated_at FROM tax_config ORDER BY code');
    res.json({ items: rows });
  }),
);

const taxConfigSchema = z.object({
  items: z.array(z.object({
    code: z.enum(['tds_194h_std', 'tds_194h_high', 'tds_194n', 'gst']),
    rate_percent: z.coerce.number().min(0).max(100),      // percent, e.g. 5 or 18
    max_amount: z.coerce.number().min(0).default(0),       // rupees; 0 = no cap
    enabled: z.boolean().default(true),
  })).min(1),
});

router.put(
  '/tax-config',
  validate(taxConfigSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof taxConfigSchema>;
    await withTransaction(async (client) => {
      for (const it of b.items) {
        await client.query(
          `UPDATE tax_config SET rate_bps = $1, max_amount_paise = $2, enabled = $3 WHERE code = $4`,
          [Math.round(it.rate_percent * 100), rupeesToPaise(it.max_amount), it.enabled, it.code],
        );
      }
    });
    await refreshTaxConfig();
    const { rows } = await query('SELECT code, label, rate_bps, max_amount_paise, enabled FROM tax_config ORDER BY code');
    res.json({ items: rows });
  }),
);

// Form 26Q source — every TDS deduction, date-ranged. JSON for the console,
// CSV for the filing (per member: PAN, section, gross, rate, TDS).
const taxReportSchema = z.object({
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});
router.get(
  '/tds',
  validate(taxReportSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const p = req.query as unknown as z.infer<typeof taxReportSchema>;
    const csv = p.format === 'csv';
    const totals = await query<{ gross: string; tds: string }>(
      `SELECT COALESCE(SUM(gross_paise),0) gross, COALESCE(SUM(tds_paise),0) tds FROM tds_records
        WHERE ($1::timestamptz IS NULL OR created_at >= $1)
          AND ($2::timestamptz IS NULL OR created_at < ($2::timestamptz + interval '1 day'))`,
      [p.from || null, p.to || null],
    );
    const { rows } = await query<{ id: string; user_id: string; full_name: string; pan: string | null; service_code: string | null; section: string; gross_paise: string; rate_bps: number; tds_paise: string; net_paise: string; created_at: string }>(
      `SELECT t.id, t.user_id, u.full_name, tp.pan, t.service_code, t.section,
              t.gross_paise, t.rate_bps, t.tds_paise, t.net_paise, t.created_at
         FROM tds_records t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN tax_profiles tp ON tp.user_id = t.user_id
        WHERE ($1::timestamptz IS NULL OR t.created_at >= $1)
          AND ($2::timestamptz IS NULL OR t.created_at < ($2::timestamptz + interval '1 day'))
        ORDER BY t.created_at DESC ${csv ? 'LIMIT 100000' : 'LIMIT 100'}`,
      [p.from || null, p.to || null],
    );
    if (csv) {
      const out = toCsv(
        ['Date', 'Member', 'PAN', 'Section', 'Service', 'Gross', 'Rate %', 'TDS', 'Net'],
        rows.map((r) => [
          new Date(r.created_at).toISOString().slice(0, 10), r.full_name, r.pan || '', r.section, r.service_code || '',
          paiseToRupees(r.gross_paise), (r.rate_bps / 100).toFixed(2), paiseToRupees(r.tds_paise), paiseToRupees(r.net_paise),
        ]),
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="tds_26q_${p.from || 'all'}_${p.to || 'now'}.csv"`);
      res.send(out);
      return;
    }
    res.json({
      total_gross_paise: bigintToNumber(totals.rows[0].gross),
      total_tds_paise: bigintToNumber(totals.rows[0].tds),
      total_tds: paiseToRupees(totals.rows[0].tds),
      items: rows.map((r) => ({
        ...r,
        gross_paise: bigintToNumber(r.gross_paise),
        tds_paise: bigintToNumber(r.tds_paise),
        net_paise: bigintToNumber(r.net_paise),
      })),
    });
  }),
);

// GST liability summary (output tax on the platform margin), date-ranged.
// JSON for the console; CSV for the GSTR working (CGST / SGST / IGST split).
router.get(
  '/gst',
  validate(taxReportSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const p = req.query as unknown as z.infer<typeof taxReportSchema>;
    const csv = p.format === 'csv';
    const totals = await query<{ base: string; cgst: string; sgst: string; igst: string }>(
      `SELECT COALESCE(SUM(taxable_base_paise),0) base, COALESCE(SUM(cgst_paise),0) cgst,
              COALESCE(SUM(sgst_paise),0) sgst, COALESCE(SUM(igst_paise),0) igst FROM gst_invoices
        WHERE ($1::timestamptz IS NULL OR created_at >= $1)
          AND ($2::timestamptz IS NULL OR created_at < ($2::timestamptz + interval '1 day'))`,
      [p.from || null, p.to || null],
    );
    const { rows } = await query<{ id: string; service_code: string | null; taxable_base_paise: string; cgst_paise: string; sgst_paise: string; igst_paise: string; place_of_supply: string | null; created_at: string }>(
      `SELECT id, service_code, taxable_base_paise, cgst_paise, sgst_paise, igst_paise, place_of_supply, created_at
         FROM gst_invoices
        WHERE ($1::timestamptz IS NULL OR created_at >= $1)
          AND ($2::timestamptz IS NULL OR created_at < ($2::timestamptz + interval '1 day'))
        ORDER BY created_at DESC ${csv ? 'LIMIT 100000' : 'LIMIT 100'}`,
      [p.from || null, p.to || null],
    );
    if (csv) {
      const out = toCsv(
        ['Date', 'Service', 'Place of supply', 'Taxable base', 'CGST', 'SGST', 'IGST', 'Total GST'],
        rows.map((r) => [
          new Date(r.created_at).toISOString().slice(0, 10), r.service_code || '', r.place_of_supply || '',
          paiseToRupees(r.taxable_base_paise), paiseToRupees(r.cgst_paise), paiseToRupees(r.sgst_paise), paiseToRupees(r.igst_paise),
          paiseToRupees(String(Number(r.cgst_paise) + Number(r.sgst_paise) + Number(r.igst_paise))),
        ]),
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="gst_${p.from || 'all'}_${p.to || 'now'}.csv"`);
      res.send(out);
      return;
    }
    const t = totals.rows[0];
    res.json({
      total_base_paise: bigintToNumber(t.base),
      total_gst_paise: bigintToNumber(t.cgst) + bigintToNumber(t.sgst) + bigintToNumber(t.igst),
      total_cgst_paise: bigintToNumber(t.cgst),
      total_sgst_paise: bigintToNumber(t.sgst),
      total_igst_paise: bigintToNumber(t.igst),
      items: rows.map((r) => ({
        ...r,
        taxable_base_paise: bigintToNumber(r.taxable_base_paise),
        cgst_paise: bigintToNumber(r.cgst_paise),
        sgst_paise: bigintToNumber(r.sgst_paise),
        igst_paise: bigintToNumber(r.igst_paise),
      })),
    });
  }),
);

// ---------------------------------------------------------------------
// Company bank accounts (for cash / bank deposit top-ups)
// ---------------------------------------------------------------------
router.get(
  '/bank-accounts',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query('SELECT * FROM company_bank_accounts ORDER BY sort_order, created_at');
    res.json({ items: rows });
  }),
);

const bankSchema = z.object({
  label: z.string().trim().min(2).max(120),
  bank_name: z.string().trim().min(2).max(120),
  account_name: z.string().trim().min(2).max(120),
  account_number: z.string().trim().regex(/^\d{6,20}$/, 'Invalid account number'),
  ifsc: z.string().trim().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC'),
  branch: z.string().trim().max(120).optional(),
  upi_id: z.string().trim().max(120).optional(),
  instructions: z.string().trim().max(500).optional(),
  is_active: z.boolean().default(true),
  sort_order: z.coerce.number().int().default(0),
});

router.post(
  '/bank-accounts',
  validate(bankSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof bankSchema>;
    const { rows } = await query(
      `INSERT INTO company_bank_accounts
         (label, bank_name, account_name, account_number, ifsc, branch, upi_id, instructions, is_active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [b.label, b.bank_name, b.account_name, b.account_number, b.ifsc,
       b.branch ?? null, b.upi_id ?? null, b.instructions ?? null, b.is_active, b.sort_order],
    );
    res.status(201).json({ bank_account: rows[0] });
  }),
);

const bankUpdateSchema = bankSchema.partial();

router.patch(
  '/bank-accounts/:id',
  validate(bankUpdateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof bankUpdateSchema>;
    const { rows } = await query(
      `UPDATE company_bank_accounts SET
          label = COALESCE($1,label), bank_name = COALESCE($2,bank_name),
          account_name = COALESCE($3,account_name), account_number = COALESCE($4,account_number),
          ifsc = COALESCE($5,ifsc), branch = COALESCE($6,branch), upi_id = COALESCE($7,upi_id),
          instructions = COALESCE($8,instructions), is_active = COALESCE($9,is_active),
          sort_order = COALESCE($10,sort_order)
        WHERE id = $11 RETURNING *`,
      [b.label ?? null, b.bank_name ?? null, b.account_name ?? null, b.account_number ?? null,
       b.ifsc ?? null, b.branch ?? null, b.upi_id ?? null, b.instructions ?? null,
       b.is_active ?? null, b.sort_order ?? null, req.params.id],
    );
    if (!rows[0]) throw ApiError.notFound('Bank account not found');
    res.json({ bank_account: rows[0] });
  }),
);

router.delete(
  '/bank-accounts/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { rowCount } = await query('DELETE FROM company_bank_accounts WHERE id = $1', [req.params.id]);
    if (!rowCount) throw ApiError.notFound('Bank account not found');
    res.status(204).send();
  }),
);

// ---------------------------------------------------------------------
// Wallet top-up requests — review queue
// ---------------------------------------------------------------------
const topupListSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get(
  '/topups',
  validate(topupListSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof topupListSchema>;
    const { rows } = await query(
      `SELECT t.id, t.user_id, u.full_name, u.username, u.role,
              t.amount_paise, t.method, t.bank_account_id, t.reference, t.proof_url, t.note,
              t.status, t.remarks, t.reviewed_at, t.created_at
         FROM wallet_topup_requests t
         JOIN users u ON u.id = t.user_id
        WHERE t.status = $1
        ORDER BY t.created_at DESC
        LIMIT $2 OFFSET $3`,
      [q.status, q.limit, q.offset],
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

const reviewSchema = z.object({ remarks: z.string().trim().max(300).optional() });

// Approve a top-up: credits the member's wallet and marks it approved.
router.post(
  '/topups/:id/approve',
  validate(reviewSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { remarks } = req.body as z.infer<typeof reviewSchema>;
    const adminId = req.user.id;
    const topupId = req.params.id;

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{ user_id: string; amount_paise: string; status: string }>(
        'SELECT user_id, amount_paise, status FROM wallet_topup_requests WHERE id = $1 FOR UPDATE',
        [topupId],
      );
      const t = rows[0];
      if (!t) throw ApiError.notFound('Top-up request not found');
      if (t.status !== 'pending') throw ApiError.conflict(`Top-up already ${t.status}`);

      await credit(client, {
        userId: t.user_id,
        amountPaise: Number(t.amount_paise),
        source: 'topup',
        referenceId: topupId,
        description: 'Wallet top-up (approved)',
      });
      // Double-entry: real cash enters the bank escrow (asset up); the
      // platform now owes the member that balance (liability up).
      await postJournal(client, {
        source: 'topup',
        reference: topupId,
        narration: 'Wallet top-up approved',
        lines: [
          { account: 'bank_escrow', direction: 'debit', amountPaise: Number(t.amount_paise) },
          { account: 'member_wallet', direction: 'credit', amountPaise: Number(t.amount_paise), walletUserId: t.user_id },
        ],
      });
      const txn = await client.query<{ id: string }>(
        `SELECT id FROM wallet_transactions
          WHERE reference_id = $1 AND source = 'topup' ORDER BY created_at DESC LIMIT 1`,
        [topupId],
      );
      const upd = await client.query(
        `UPDATE wallet_topup_requests
            SET status = 'approved', reviewed_by = $1, reviewed_at = now(),
                remarks = $2, wallet_txn_id = $3
          WHERE id = $4 RETURNING id, user_id, amount_paise, status, reviewed_at`,
        [adminId, remarks ?? null, txn.rows[0]?.id ?? null, topupId],
      );
      return upd.rows[0];
    });

    await logAudit({ actorId: adminId, actorRole: req.user.role, action: 'topup.approve',
      targetType: 'topup', targetId: topupId, detail: { remarks: remarks ?? null, amount_paise: Number(result.amount_paise) } });
    res.json({ request: result });
  }),
);

// Reject a top-up (no wallet change).
router.post(
  '/topups/:id/reject',
  validate(reviewSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { remarks } = req.body as z.infer<typeof reviewSchema>;
    const { rows } = await query(
      `UPDATE wallet_topup_requests
          SET status = 'rejected', reviewed_by = $1, reviewed_at = now(), remarks = $2
        WHERE id = $3 AND status = 'pending'
        RETURNING id, status, reviewed_at`,
      [req.user.id, remarks ?? null, req.params.id],
    );
    if (!rows[0]) throw ApiError.conflict('Top-up not found or already reviewed');
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'topup.reject',
      targetType: 'topup', targetId: req.params.id, detail: { remarks: remarks ?? null } });
    res.json({ request: rows[0] });
  }),
);

// ---------------------------------------------------------------------
// T+1 settlement report — per-member daily summary (JSON or CSV).
// ---------------------------------------------------------------------
const settlementSchema = z.object({
  date: z.string().trim().optional(), // YYYY-MM-DD; defaults to yesterday
  format: z.enum(['json', 'csv']).default('json'),
});
router.get(
  '/settlement-report',
  validate(settlementSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof settlementSchema>;
    const day = q.date || null;
    const { rows } = await query<Record<string, string>>(
      `SELECT u.full_name, u.phone, u.role,
              COUNT(*) FILTER (WHERE t.status='success')          AS txns,
              COALESCE(SUM(t.amount_paise)     FILTER (WHERE t.status='success'),0) AS gtv_paise,
              COALESCE(SUM(t.commission_paise) FILTER (WHERE t.status='success'),0) AS commission_paise,
              COALESCE(SUM(t.charge_paise)     FILTER (WHERE t.status='success'),0) AS charge_paise
         FROM transactions t JOIN users u ON u.id = t.user_id
        WHERE t.created_at >= COALESCE($1::date, current_date - 1)
          AND t.created_at <  COALESCE($1::date, current_date - 1) + interval '1 day'
        GROUP BY u.id, u.full_name, u.phone, u.role
       HAVING COUNT(*) FILTER (WHERE t.status='success') > 0
        ORDER BY gtv_paise DESC`,
      [day],
    );
    const r = (p: string) => paiseToRupees(p);
    const reportDate = day || 'yesterday';
    if (q.format === 'csv') {
      const csv = toCsv(
        ['Member', 'Phone', 'Role', 'Txns', 'GTV', 'Commission', 'Charge'],
        rows.map((x) => [x.full_name, x.phone, x.role, x.txns, r(x.gtv_paise), r(x.commission_paise), r(x.charge_paise)]),
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="settlement_${reportDate}.csv"`);
      res.send(csv);
      return;
    }
    const totals = {
      txns: rows.reduce((a, x) => a + Number(x.txns), 0),
      gtv_paise: rows.reduce((a, x) => a + Number(x.gtv_paise), 0),
      commission_paise: rows.reduce((a, x) => a + Number(x.commission_paise), 0),
      charge_paise: rows.reduce((a, x) => a + Number(x.charge_paise), 0),
    };
    res.json({ date: reportDate, items: rows, totals });
  }),
);

// ---------------------------------------------------------------------
// AI Integration Studio — draft a `dynamic` provider config from pasted docs,
// then self-test the mapping before saving/activating. No developer, no deploy.
// ---------------------------------------------------------------------
const aiDraftSchema = z.object({
  docs: z.string().trim().max(60000).default(''),
  services: z.array(z.string().trim().min(1).max(40)).max(14).default([]),
});
router.post(
  '/integrations/ai-draft',
  validate(aiDraftSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof aiDraftSchema>;
    const draft = await draftProviderConfig(b.docs, b.services);
    res.json(draft);
  }),
);

// Self-test a dynamic config (dry run): resolve the request the platform would
// send for a sample transaction, so the mapping is validated before going live.
const providerTestSchema = z.object({
  service: z.string().trim().min(1).max(40),
  config: z.record(z.any()),
  creds: z
    .object({
      base_url: z.string().trim().optional(),
      api_key: z.string().trim().optional(),
      api_secret: z.string().trim().optional(),
      auth_token: z.string().trim().optional(),
      partner_id: z.string().trim().optional(),
    })
    .optional(),
  sample: z.record(z.string()).optional(),
  live: z.boolean().optional(), // true = actually call the provider (test data)
});
router.post(
  '/integrations/provider-test',
  validate(providerTestSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof providerTestSchema>;
    const defaults: Record<string, string> = {
      reference: 'TESTREF12345678', amount: '100.00', amount_paise: '10000',
      account_number: '000201548796', ifsc: 'ICIC0000002', beneficiary_name: 'Test Payee',
      mode: 'IMPS', operator: 'Jio', number: '9812345678', recharge_type: 'prepaid',
      biller_id: 'MSEB00000MAH01', consumer_number: '180012345678', category: 'electricity', vpa: 'test@okhdfcbank',
    };
    const cred = {
      baseUrl: b.creds?.base_url ?? '',
      apiKey: b.creds?.api_key ?? '',
      apiSecret: b.creds?.api_secret ?? '',
      authToken: b.creds?.auth_token ?? '',
      partnerId: b.creds?.partner_id ?? '',
      extra: b.config,
    };
    const sample = { ...defaults, ...(b.sample ?? {}) };
    // A live test sends a REAL request to the provider — validate the mapping
    // (dry run) first so we never fire a call that obviously can't work.
    const dry = dryRunDynamic(cred, b.service, sample);
    if (!b.live || !dry.ok) {
      res.json({ live: false, ...dry });
      return;
    }
    const result = await liveTestDynamic(cred, b.service, sample);
    res.json({ live: true, request: { url: dry.url, method: dry.method }, result });
  }),
);

// ---------------------------------------------------------------------
// AI Dev Desk — feature / bug / UI requests: file -> AI plan -> approve ->
// dispatch to automation (the free-AI coding agent) which opens a PR.
// ---------------------------------------------------------------------
const devReqSchema = z.object({
  kind: z.enum(['feature', 'bug', 'ui']).default('feature'),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(8000).default(''),
  area: z.string().trim().max(80).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
});
router.get(
  '/devdesk',
  asyncHandler(async (req: Request, res: Response) => {
    const items = await listDevRequests({
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
    });
    res.json({ items });
  }),
);
router.post(
  '/devdesk',
  validate(devReqSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof devReqSchema>;
    const item = await createDevRequest(req.user?.id ?? null, b);
    res.status(201).json({ request: item });
  }),
);
// Ask the AI to draft the build/fix plan (the "box").
router.post(
  '/devdesk/:id/triage',
  asyncHandler(async (req: Request, res: Response) => {
    const dr = await getDevRequest(req.params.id);
    if (!dr) throw ApiError.notFound('Request not found');
    const draft = await analyzeDevRequest(String(dr.kind), String(dr.title), String(dr.description ?? ''));
    const updated = await setPlan(req.params.id, { ...draft.plan, _source: draft.source, _model: draft.model });
    if (req.user) await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'devdesk.triage',
      targetType: 'dev_request', targetId: req.params.id, detail: { source: draft.source } });
    res.json({ request: updated, source: draft.source });
  }),
);
const decideSchema = z.object({ remark: z.string().trim().max(2000).optional() });
// Approve -> dispatch to automation (n8n / coding agent) via emitEvent.
router.post(
  '/devdesk/:id/approve',
  validate(decideSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof decideSchema>;
    const dr = await getDevRequest(req.params.id);
    if (!dr) throw ApiError.notFound('Request not found');
    const updated = await setStatus(req.params.id, 'approved', b.remark);
    emitEvent('devdesk.approved', {
      ticket_no: dr.ticket_no, kind: dr.kind, title: dr.title, description: dr.description,
      plan: dr.ai_plan, approved_by: req.user?.id, remark: b.remark ?? null,
    });
    if (req.user) await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'devdesk.approve',
      targetType: 'dev_request', targetId: req.params.id, detail: { ticket_no: dr.ticket_no } });
    res.json({ request: updated });
  }),
);
router.post(
  '/devdesk/:id/reject',
  validate(decideSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof decideSchema>;
    const updated = await setStatus(req.params.id, 'rejected', b.remark);
    if (!updated) throw ApiError.notFound('Request not found');
    res.json({ request: updated });
  }),
);
// Mark progress (dispatched / done) — e.g. once the agent opens/merges a PR.
const devStatusSchema = z.object({ status: z.enum(['dispatched', 'done']), remark: z.string().trim().max(2000).optional() });
router.post(
  '/devdesk/:id/status',
  validate(devStatusSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof devStatusSchema>;
    const updated = await setStatus(req.params.id, b.status, b.remark);
    if (!updated) throw ApiError.notFound('Request not found');
    res.json({ request: updated });
  }),
);

// ---------------------------------------------------------------------
// Service providers — multiple per service, one active (routing target)
// ---------------------------------------------------------------------
router.get(
  '/services/:code/providers',
  asyncHandler(async (req: Request, res: Response) => {
    const base = (env.API_BASE_URL || '').replace(/\/+$/, '');
    const { rows } = await query<Record<string, unknown>>(
      'SELECT * FROM service_providers WHERE service_code = $1 ORDER BY priority, created_at',
      [req.params.code],
    );
    // Never leak raw secrets; expose a callback URL + "is a secret set?" flags.
    const items = rows.map((p) => ({
      ...p,
      api_secret: undefined,
      auth_token: undefined,
      webhook_secret: undefined,
      has_api_secret: Boolean(p.api_secret),
      has_webhook_secret: Boolean(p.webhook_secret),
      callback_url: `${base}/api/v1/webhooks/provider/${p.id}`,
    }));
    res.json({ items });
  }),
);

const providerSchema = z.object({
  label: z.string().trim().min(2).max(120),
  driver: z.enum(['sandbox', 'aggregator', 'razorpay', 'generic', 'aeronpay', 'eko', 'dynamic']).default('sandbox'),
  base_url: z.string().trim().max(300).optional(),
  api_key: z.string().trim().max(300).optional(),
  api_secret: z.string().trim().max(300).optional(),
  auth_token: z.string().trim().max(600).optional(),
  partner_id: z.string().trim().max(120).optional(),
  webhook_secret: z.string().trim().max(300).optional(),
  extra: z.record(z.any()).optional(),
  is_active: z.boolean().default(false),
  priority: z.coerce.number().int().default(0),
});

router.post(
  '/services/:code/providers',
  validate(providerSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof providerSchema>;
    const code = req.params.code;
    const svc = await query('SELECT 1 FROM services WHERE code = $1', [code]);
    if (!svc.rowCount) throw ApiError.notFound('Service not found');

    const provider = await withTransaction(async (client) => {
      if (b.is_active) {
        await client.query(
          'UPDATE service_providers SET is_active = false WHERE service_code = $1 AND is_active = true',
          [code],
        );
      }
      const { rows } = await client.query(
        `INSERT INTO service_providers
           (service_code, label, driver, base_url, api_key, api_secret, auth_token, partner_id, webhook_secret, extra, is_active, priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [code, b.label, b.driver, b.base_url ?? null, b.api_key ?? null, b.api_secret ?? null,
         b.auth_token ?? null, b.partner_id ?? null, b.webhook_secret ?? null, JSON.stringify(b.extra ?? {}), b.is_active, b.priority],
      );
      return rows[0];
    });
    await refreshProviderRegistry();
    res.status(201).json({ provider });
  }),
);

const providerUpdateSchema = providerSchema.partial();

router.patch(
  '/providers/:id',
  validate(providerUpdateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof providerUpdateSchema>;
    const provider = await withTransaction(async (client) => {
      const cur = await client.query<{ service_code: string }>(
        'SELECT service_code FROM service_providers WHERE id = $1',
        [req.params.id],
      );
      if (!cur.rows[0]) throw ApiError.notFound('Provider not found');
      if (b.is_active === true) {
        await client.query(
          'UPDATE service_providers SET is_active = false WHERE service_code = $1 AND is_active = true AND id <> $2',
          [cur.rows[0].service_code, req.params.id],
        );
      }
      const { rows } = await client.query(
        `UPDATE service_providers SET
            label = COALESCE($1,label), driver = COALESCE($2,driver),
            base_url = COALESCE($3,base_url), api_key = COALESCE($4,api_key),
            api_secret = COALESCE($5,api_secret), auth_token = COALESCE($6,auth_token),
            partner_id = COALESCE($7,partner_id), extra = COALESCE($8,extra),
            is_active = COALESCE($9,is_active), priority = COALESCE($10,priority),
            webhook_secret = COALESCE($12,webhook_secret)
          WHERE id = $11 RETURNING *`,
        [b.label ?? null, b.driver ?? null, b.base_url ?? null, b.api_key ?? null,
         b.api_secret ?? null, b.auth_token ?? null, b.partner_id ?? null,
         b.extra === undefined ? null : JSON.stringify(b.extra),
         b.is_active ?? null, b.priority ?? null, req.params.id, b.webhook_secret ?? null],
      );
      return rows[0];
    });
    await refreshProviderRegistry();
    res.json({ provider });
  }),
);

// Make a provider the active one for its service.
router.post(
  '/providers/:id/activate',
  asyncHandler(async (req: Request, res: Response) => {
    // Multiple providers can be active per service (e.g. Recharge 1 + 2). This
    // just turns the chosen one on; use /deactivate to turn one off.
    const { rows } = await query(
      'UPDATE service_providers SET is_active = true WHERE id = $1 RETURNING *',
      [req.params.id],
    );
    if (!rows[0]) throw ApiError.notFound('Provider not found');
    await refreshProviderRegistry();
    if (req.user) await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'provider.activate',
      targetType: 'provider', targetId: req.params.id, detail: { service_code: rows[0].service_code, label: rows[0].label } });
    res.json({ provider: rows[0] });
  }),
);

router.post(
  '/providers/:id/deactivate',
  asyncHandler(async (req: Request, res: Response) => {
    const { rows } = await query(
      'UPDATE service_providers SET is_active = false WHERE id = $1 RETURNING *',
      [req.params.id],
    );
    if (!rows[0]) throw ApiError.notFound('Provider not found');
    await refreshProviderRegistry();
    if (req.user) await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'provider.deactivate',
      targetType: 'provider', targetId: req.params.id, detail: { service_code: rows[0].service_code, label: rows[0].label } });
    res.json({ provider: rows[0] });
  }),
);

router.delete(
  '/providers/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { rowCount } = await query('DELETE FROM service_providers WHERE id = $1', [req.params.id]);
    if (!rowCount) throw ApiError.notFound('Provider not found');
    await refreshProviderRegistry();
    res.status(204).send();
  }),
);

// ---- Catalog: recharge operators + BBPS billers ---------------------------
// Admin manages the recharge operator list and the biller directory without a
// deploy; members' dropdowns read the enabled rows.
router.get(
  '/operators',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query('SELECT code, name, type, enabled, sort_order FROM operators ORDER BY type, sort_order, name');
    res.json({ items: rows });
  }),
);
const operatorSchema = z.object({
  code: z.string().trim().min(1).max(40).regex(/^[A-Z0-9_]+$/, 'Code: A-Z, 0-9, _'),
  name: z.string().trim().min(1).max(80),
  type: z.enum(['prepaid', 'postpaid', 'dth']),
  enabled: z.boolean().default(true),
  sort_order: z.coerce.number().int().min(0).max(999).default(0),
});
router.post(
  '/operators',
  validate(operatorSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof operatorSchema>;
    const { rows } = await query(
      `INSERT INTO operators (code, name, type, enabled, sort_order) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type,
         enabled = EXCLUDED.enabled, sort_order = EXCLUDED.sort_order RETURNING *`,
      [b.code, b.name, b.type, b.enabled, b.sort_order],
    );
    res.json({ operator: rows[0] });
  }),
);
router.delete(
  '/operators/:code',
  asyncHandler(async (req: Request, res: Response) => {
    const { rowCount } = await query('DELETE FROM operators WHERE code = $1', [req.params.code]);
    if (!rowCount) throw ApiError.notFound('Operator not found');
    res.status(204).send();
  }),
);

router.get(
  '/billers',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query('SELECT biller_id, name, category, coverage, enabled FROM billers ORDER BY category, name');
    res.json({ items: rows });
  }),
);
const billerSchema = z.object({
  biller_id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(40),
  coverage: z.enum(['national', 'state']).default('national'),
  enabled: z.boolean().default(true),
});
router.post(
  '/billers',
  validate(billerSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof billerSchema>;
    const { rows } = await query(
      `INSERT INTO billers (biller_id, name, category, coverage, enabled) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (biller_id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
         coverage = EXCLUDED.coverage, enabled = EXCLUDED.enabled RETURNING *`,
      [b.biller_id, b.name, b.category, b.coverage, b.enabled],
    );
    res.json({ biller: rows[0] });
  }),
);
router.delete(
  '/billers/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { rowCount } = await query('DELETE FROM billers WHERE biller_id = $1', [req.params.id]);
    if (!rowCount) throw ApiError.notFound('Biller not found');
    res.status(204).send();
  }),
);

// Known-provider directory — quick-pick starting points for adding a provider.
// Carries no credentials; the admin supplies real base URL + keys, then Tests.
router.get(
  '/provider-directory',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query(
      'SELECT key, name, website, services, suggested_driver, notes FROM provider_directory WHERE enabled = true ORDER BY sort_order, name',
    );
    res.json({ items: rows });
  }),
);

// Go-live pre-flight: verify a saved provider's config + endpoint reachability
// WITHOUT running a real transaction. Safe to run before activating live keys.
router.post(
  '/providers/:id/test',
  asyncHandler(async (req: Request, res: Response) => {
    const { rows } = await query<import('../../providers/health').ProviderRow>(
      `SELECT id, service_code, label, driver, base_url, api_key, api_secret, auth_token, partner_id, is_active
         FROM service_providers WHERE id = $1`,
      [req.params.id],
    );
    if (!rows[0]) throw ApiError.notFound('Provider not found');
    const { probeProvider } = await import('../../providers/health');
    const result = await probeProvider(rows[0]);
    res.json({ provider: { id: rows[0].id, label: rows[0].label, driver: rows[0].driver, service_code: rows[0].service_code }, ...result });
  }),
);

// Go-live readiness: for every service, which provider is active and whether it
// is still the sandbox — so the admin can see at a glance what is not yet live.
router.get(
  '/go-live',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query<{ service_code: string; label: string | null; driver: string | null; provider_id: string | null; total_providers: string }>(
      `SELECT s.service_code,
              a.label, a.driver, a.id AS provider_id,
              (SELECT COUNT(*) FROM service_providers sp WHERE sp.service_code = s.service_code)::text AS total_providers
         FROM (SELECT DISTINCT service_code FROM service_providers) s
         LEFT JOIN service_providers a ON a.service_code = s.service_code AND a.is_active
        ORDER BY s.service_code`,
    );
    const items = rows.map((r) => ({
      service_code: r.service_code,
      active_provider: r.label,
      driver: r.driver,
      provider_id: r.provider_id,
      total_providers: Number(r.total_providers),
      live: !!r.driver && r.driver !== 'sandbox',
      status: !r.driver ? 'none_active' : r.driver === 'sandbox' ? 'sandbox' : 'live',
    }));
    res.json({
      items,
      live_count: items.filter((i) => i.live).length,
      sandbox_count: items.filter((i) => i.status === 'sandbox').length,
      none_count: items.filter((i) => i.status === 'none_active').length,
    });
  }),
);

export default router;
