import crypto from 'crypto';
import http from 'http';
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
import { debit, credit, freezeWallet, unfreezeWallet, recoverChargeback, getWalletByUser } from '../wallet/wallet.service';
import { createMember } from '../members/members.service';
import { usernameSchema } from '../auth/auth.schemas';
import { dashboardStats } from './admin.dashboard';
import { refreshProviderRegistry } from '../../providers/registry';
import { dryRunDynamic, liveTestDynamic } from '../../providers/dynamic';
import { toCsv } from '../reports/reports.service';
import { draftProviderConfig, analyzeDevRequest, aiChat } from '../ai/ai.service';
import { createDevRequest, listDevRequests, getDevRequest, setPlan, setStatus } from '../devdesk/devdesk.service';
import { postJournal } from '../_shared/ledger';
import { settleByReference } from '../_shared/settle';
import { listTenants, getTenant, createTenant, updateTenant,
  listDomains, addDomain, verifyDomain, updateDomain, deleteDomain,
  tenantServiceMatrix, setTenantServiceVisibility,
  tenantOverview, getTenantSettings, setTenantSetting } from '../tenant/tenant.service';
import { listInvoices, generateInvoice, issueInvoice, markInvoicePaid, voidInvoice } from '../tenant/tenant.billing.service';
import * as bank from '../bank/bank.service';
import { listErrors, getError, setErrorStatus, diagnoseError } from '../telemetry/error.service';
import { escalateError } from '../telemetry/escalate.service';
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
  tenant_id: z.string().uuid().optional(), // white-label Stage 4: scope to one tenant's network
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
          AND ($6::uuid IS NULL OR tenant_id = $6)
        ORDER BY created_at DESC
        LIMIT $4 OFFSET $5`,
      [q.role ?? null, q.status ?? null, like, q.limit, q.offset, q.tenant_id ?? null],
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
    provider: z.string().trim().max(60).optional(),
    status: z.enum(['processed', 'rejected', 'pending']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }), 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { provider?: string; status?: string; limit: number };
    const statusFilter =
      q.status === 'rejected' ? 'AND auth_ok = false'
      : q.status === 'processed' ? 'AND auth_ok = true AND processed = true'
      : q.status === 'pending' ? 'AND auth_ok = true AND processed = false'
      : '';
    const { rows } = await query(
      `SELECT id, provider, event_type, external_id, reference, settled_status,
              processed, auth_ok, error, http_status, received_at
         FROM provider_events
        WHERE ($1::text IS NULL OR provider = $1) ${statusFilter}
        ORDER BY received_at DESC LIMIT $2`,
      [q.provider ?? null, q.limit],
    );
    res.json({ items: rows });
  }),
);

// Full detail of one webhook event, including the raw payload.
router.get(
  '/provider-events/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { rows } = await query('SELECT * FROM provider_events WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw ApiError.notFound('Event not found');
    res.json({ event: rows[0] });
  }),
);

// Reprocess: re-run settlement for an event's reference (idempotent/terminal-safe).
router.post(
  '/provider-events/:id/reprocess',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rows } = await query<{ provider: string; reference: string | null; payload: Record<string, unknown> | null; settled_status: string | null }>(
      'SELECT provider, reference, payload, settled_status FROM provider_events WHERE id = $1',
      [req.params.id],
    );
    const ev = rows[0];
    if (!ev) throw ApiError.notFound('Event not found');
    if (!ev.reference) throw ApiError.badRequest('Event has no reference to reprocess');
    const p = ev.payload ?? {};
    const status = (ev.settled_status as 'success' | 'failed' | 'pending' | null) ?? 'pending';
    const providerRef = (p.transactionId ?? p.transaction_id ?? p.providerRef ?? p.opr_referenceId) as string | undefined;
    const utr = (p.utr ?? p.bank_ref ?? p.rrn) as string | undefined;
    const ok = await settleByReference(ev.reference, ev.provider, { status, providerRef, utr, message: 'reprocessed by admin' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'webhook.reprocess',
      targetType: 'provider_event', targetId: req.params.id, detail: { reference: ev.reference, status } });
    res.json({ reprocessed: ok, reference: ev.reference, status });
  }),
);

// ---- White-label tenants -------------------------------------------------
const tenantSchema = z.object({
  brand_name: z.string().trim().min(1).max(80),
  owner_user_id: z.string().uuid().nullable().optional(),
  logo_url: z.string().trim().max(500).nullable().optional(),
  logo_emoji: z.string().trim().max(16).nullable().optional(),
  primary_color: z.string().trim().max(32).nullable().optional(),
  tagline: z.string().trim().max(160).nullable().optional(),
  support_email: z.string().trim().max(120).nullable().optional(),
  support_phone: z.string().trim().max(20).nullable().optional(),
  company_name: z.string().trim().max(120).nullable().optional(),
  status: z.enum(['active', 'suspended']).optional(),
});

router.get('/tenants', asyncHandler(async (_req: Request, res: Response) => {
  res.json({ items: await listTenants() });
}));

router.get('/tenants/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json({ tenant: await getTenant(req.params.id) });
}));

router.post('/tenants', validate(tenantSchema), asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const t = await createTenant(req.body as z.infer<typeof tenantSchema>);
  await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'tenant.create',
    targetType: 'tenant', targetId: t.id, detail: { brand_name: t.brand_name, owner: t.owner_user_id } });
  res.status(201).json({ tenant: t });
}));

router.put('/tenants/:id', validate(tenantSchema.partial()), asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const t = await updateTenant(req.params.id, req.body as Partial<z.infer<typeof tenantSchema>>);
  await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'tenant.update',
    targetType: 'tenant', targetId: req.params.id, detail: req.body });
  res.json({ tenant: t });
}));

// ---- White-label custom domains (Stage 2) --------------------------------
router.get('/tenants/:id/domains', asyncHandler(async (req: Request, res: Response) => {
  res.json({ items: await listDomains(req.params.id) });
}));

router.post('/tenants/:id/domains',
  validate(z.object({ domain: z.string().trim().min(3).max(255) })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const d = await addDomain(req.params.id, (req.body as { domain: string }).domain);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'tenant.domain.add',
      targetType: 'tenant', targetId: req.params.id, detail: { domain: d.domain } });
    res.status(201).json({ domain: d });
  }));

router.post('/tenants/:id/domains/:domainId/verify', asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const result = await verifyDomain(req.params.id, req.params.domainId);
  if (result.verified) {
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'tenant.domain.verify',
      targetType: 'tenant', targetId: req.params.id, detail: { domainId: req.params.domainId } });
  }
  res.json(result);
}));

router.put('/tenants/:id/domains/:domainId',
  validate(z.object({ is_primary: z.boolean().optional(), ssl_status: z.enum(['pending', 'active', 'error']).optional() })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const d = await updateDomain(req.params.id, req.params.domainId, req.body as { is_primary?: boolean; ssl_status?: 'pending' | 'active' | 'error' });
    res.json({ domain: d });
  }));

router.delete('/tenants/:id/domains/:domainId', asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  await deleteDomain(req.params.id, req.params.domainId);
  await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'tenant.domain.delete',
    targetType: 'tenant', targetId: req.params.id, detail: { domainId: req.params.domainId } });
  res.status(204).send();
}));

// ---- White-label per-tenant service visibility (Stage 3) -----------------
router.get('/tenants/:id/services', asyncHandler(async (req: Request, res: Response) => {
  res.json({ items: await tenantServiceMatrix(req.params.id) });
}));

router.put('/tenants/:id/services/:code',
  validate(z.object({ visible: z.boolean() })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    await setTenantServiceVisibility(req.params.id, req.params.code, (req.body as { visible: boolean }).visible);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'tenant.service.visibility',
      targetType: 'tenant', targetId: req.params.id, detail: { code: req.params.code, visible: req.body.visible } });
    res.json({ ok: true });
  }));

// ---- White-label tenant overview + policy settings (Stage 4) -------------
router.get('/tenants/:id/overview', asyncHandler(async (req: Request, res: Response) => {
  res.json({ overview: await tenantOverview(req.params.id) });
}));

router.get('/tenants/:id/settings', asyncHandler(async (req: Request, res: Response) => {
  res.json({ settings: await getTenantSettings(req.params.id) });
}));

router.put('/tenants/:id/settings',
  validate(z.object({ key: z.string().trim().min(1).max(60), value: z.string().max(500) })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { key, value } = req.body as { key: string; value: string };
    await setTenantSetting(req.params.id, key, value);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'tenant.setting',
      targetType: 'tenant', targetId: req.params.id, detail: { key, value: key === 'webhook_secret' ? '•••' : value } });
    res.json({ ok: true });
  }));

// ---- White-label partner billing (Stage 5) -------------------------------
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

router.get('/tenants/:id/invoices', asyncHandler(async (req: Request, res: Response) => {
  res.json({ items: await listInvoices(req.params.id) });
}));

router.post('/tenants/:id/invoices',
  validate(z.object({ period_start: isoDate, period_end: isoDate, notes: z.string().max(500).optional() })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as { period_start: string; period_end: string; notes?: string };
    const inv = await generateInvoice(req.params.id, b.period_start, b.period_end, b.notes);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'tenant.invoice.generate',
      targetType: 'tenant_invoice', targetId: inv.id, detail: { tenant: req.params.id, period: [b.period_start, b.period_end], net_payable_paise: inv.net_payable_paise } });
    res.status(201).json({ invoice: inv });
  }));

router.post('/invoices/:invoiceId/issue', asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const inv = await issueInvoice(req.params.invoiceId);
  await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'tenant.invoice.issue',
    targetType: 'tenant_invoice', targetId: inv.id, detail: { reference: inv.reference } });
  res.json({ invoice: inv });
}));

router.post('/invoices/:invoiceId/pay',
  validate(z.object({ settlement_ref: z.string().trim().max(120).optional() })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const inv = await markInvoicePaid(req.params.invoiceId, (req.body as { settlement_ref?: string }).settlement_ref ?? '');
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'tenant.invoice.pay',
      targetType: 'tenant_invoice', targetId: inv.id, detail: { settlement_ref: inv.settlement_ref, net_payable_paise: inv.net_payable_paise } });
    res.json({ invoice: inv });
  }));

router.post('/invoices/:invoiceId/void', asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const inv = await voidInvoice(req.params.invoiceId);
  await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'tenant.invoice.void',
    targetType: 'tenant_invoice', targetId: inv.id, detail: {} });
  res.json({ invoice: inv });
}));

// ---- Connected Banking ---------------------------------------------------
const connSchema = z.object({
  label: z.string().trim().min(1).max(80),
  owner_user_id: z.string().uuid().nullable().optional(),
  driver: z.string().trim().max(40).optional(),
  bank_name: z.string().trim().max(80).nullable().optional(),
  account_name: z.string().trim().max(120).nullable().optional(),
  account_number: z.string().trim().max(40).nullable().optional(), // stored masked only
  ifsc: z.string().trim().max(20).nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

router.get('/bank/connections', asyncHandler(async (_req: Request, res: Response) => {
  res.json({ items: await bank.listConnections() });
}));

router.get('/bank/connections/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json({ connection: await bank.getConnection(req.params.id) });
}));

router.post('/bank/connections', validate(connSchema), asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const c = await bank.createConnection(req.body as bank.ConnectionInput);
  await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'bank.connection.create',
    targetType: 'bank_connection', targetId: c.id, detail: { label: c.label, driver: c.driver } });
  res.status(201).json({ connection: c });
}));

router.put('/bank/connections/:id', validate(connSchema.partial()), asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const c = await bank.updateConnection(req.params.id, req.body as Partial<bank.ConnectionInput> & { status?: 'active' | 'disabled' });
  await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'bank.connection.update',
    targetType: 'bank_connection', targetId: req.params.id, detail: req.body });
  res.json({ connection: c });
}));

router.post('/bank/connections/:id/balance',
  validate(z.object({ balance_paise: z.coerce.number().int() })),
  asyncHandler(async (req: Request, res: Response) => {
    const c = await bank.setBalance(req.params.id, (req.body as { balance_paise: number }).balance_paise);
    res.json({ connection: c });
  }));

router.get('/bank/connections/:id/virtual-accounts', asyncHandler(async (req: Request, res: Response) => {
  res.json({ items: await bank.listVirtualAccounts(req.params.id) });
}));

router.post('/bank/connections/:id/virtual-accounts',
  validate(z.object({ user_id: z.string().uuid(), va_number: z.string().trim().min(3).max(60),
    va_ifsc: z.string().trim().max(20).optional(), upi_handle: z.string().trim().max(120).optional() })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as { user_id: string; va_number: string; va_ifsc?: string; upi_handle?: string };
    const va = await bank.assignVirtualAccount(req.params.id, b.user_id, b.va_number, b.va_ifsc, b.upi_handle);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'bank.va.assign',
      targetType: 'bank_connection', targetId: req.params.id, detail: { user_id: b.user_id, va_number: b.va_number } });
    res.status(201).json({ virtual_account: va });
  }));

router.get('/bank/connections/:id/statement', asyncHandler(async (req: Request, res: Response) => {
  res.json({ items: await bank.listStatement(req.params.id) });
}));

router.post('/bank/connections/:id/statement',
  validate(z.object({ lines: z.array(z.object({
    direction: z.enum(['credit', 'debit']), amount_paise: z.coerce.number().int().positive(),
    txn_time: z.string().optional(), balance_after_paise: z.coerce.number().int().nullable().optional(),
    utr: z.string().max(60).nullable().optional(), counterparty: z.string().max(120).nullable().optional(),
    narration: z.string().max(240).nullable().optional(), external_id: z.string().max(120).nullable().optional(),
  })).min(1) })),
  asyncHandler(async (req: Request, res: Response) => {
    const inserted = await bank.syncStatement(req.params.id, (req.body as { lines: bank.StatementLine[] }).lines);
    res.json({ inserted });
  }));

router.get('/bank/connections/:id/collections', asyncHandler(async (req: Request, res: Response) => {
  res.json({ items: await bank.listCollections(req.params.id) });
}));

// Manual collection ingest (reconciliation / testing) — same path the webhook uses.
router.post('/bank/connections/:id/collections',
  validate(z.object({ amount_paise: z.coerce.number().int().positive(), external_id: z.string().trim().min(1).max(120),
    va_number: z.string().trim().max(60).optional(), user_id: z.string().uuid().optional(),
    utr: z.string().trim().max(60).optional(), payer: z.string().trim().max(120).optional() })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const result = await bank.recordCollection(req.params.id, req.body as bank.CollectionInput);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'bank.collection.ingest',
      targetType: 'bank_connection', targetId: req.params.id, detail: { external_id: req.body.external_id, status: result.status } });
    res.status(201).json({ collection: result });
  }));

router.post('/bank/collections/:collectionId/apply',
  validate(z.object({ user_id: z.string().uuid() })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const result = await bank.applyCollection(req.params.collectionId, (req.body as { user_id: string }).user_id);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'bank.collection.apply',
      targetType: 'bank_collection', targetId: req.params.collectionId, detail: { user_id: req.body.user_id } });
    res.json({ collection: result });
  }));

// ---- Error monitor + AI triage -------------------------------------------
router.get('/errors',
  validate(z.object({ status: z.enum(['open', 'triaged', 'resolved', 'ignored']).optional(),
    source: z.enum(['web', 'api']).optional() }), 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as { status?: string; source?: string };
    res.json({ items: await listErrors(q) });
  }));

router.get('/errors/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json({ error_report: await getError(req.params.id) });
}));

router.post('/errors/:id/status',
  validate(z.object({ status: z.enum(['open', 'triaged', 'resolved', 'ignored']) })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const r = await setErrorStatus(req.params.id, (req.body as { status: 'open' | 'triaged' | 'resolved' | 'ignored' }).status);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'error.status',
      targetType: 'error_report', targetId: req.params.id, detail: { status: req.body.status } });
    res.json({ error_report: r });
  }));

// Ask the AI to diagnose + draft a fix (suggestion only — never auto-applied).
router.post('/errors/:id/diagnose', asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const r = await diagnoseError(req.params.id);
  await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'error.diagnose',
    targetType: 'error_report', targetId: req.params.id, detail: {} });
  res.json({ error_report: r });
}));

// Escalate to a GitHub issue → a Claude Code workflow opens a draft fix PR.
// Opens an issue only; never merges or deploys. Needs GITHUB_AUTOFIX_* config.
router.post('/errors/:id/escalate', asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const r = await escalateError(req.params.id);
  await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'error.escalate',
    targetType: 'error_report', targetId: req.params.id, detail: { ref: r.escalated_ref } });
  res.json(r);
}));

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

// ---- Wallet snapshot (balance / held / available / frozen) ---------------
router.get(
  '/users/:id/wallet',
  asyncHandler(async (req: Request, res: Response) => {
    const wallet = await getWalletByUser(req.params.id);
    res.json({ wallet });
  }),
);

// ---- Wallet freeze / unfreeze (block ALL spends) -------------------------
const freezeSchema = z.object({ reason: z.string().trim().max(200).optional() });

router.post(
  '/users/:id/freeze',
  validate(freezeSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof freezeSchema>;
    const wallet = await freezeWallet(req.params.id, req.user.id, b.reason);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'wallet.freeze',
      targetType: 'user', targetId: req.params.id, detail: { reason: b.reason ?? null } });
    res.json({ wallet });
  }),
);

router.post(
  '/users/:id/unfreeze',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const wallet = await unfreezeWallet(req.params.id);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'wallet.unfreeze',
      targetType: 'user', targetId: req.params.id, detail: {} });
    res.json({ wallet });
  }),
);

// ---- Chargeback recovery (claw back a loss, cascading up the upline) ------
const chargebackSchema = z.object({
  amount: z.coerce.number().positive().max(10000000), // rupees
  reason: z.string().trim().max(200).optional(),
  reference: z.string().trim().max(64).optional(),
});

router.post(
  '/users/:id/chargeback',
  validate(chargebackSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof chargebackSchema>;
    const user = await query('SELECT 1 FROM users WHERE id = $1', [req.params.id]);
    if (!user.rowCount) throw ApiError.notFound('User not found');
    const adminId = req.user.id;
    const result = await withTransaction((client) =>
      recoverChargeback(client, {
        originUserId: req.params.id,
        amountPaise: rupeesToPaise(b.amount),
        adminId,
        reason: b.reason,
        reference: b.reference,
      }),
    );
    await logAudit({ actorId: adminId, actorRole: req.user.role, action: 'wallet.chargeback',
      targetType: 'user', targetId: req.params.id,
      detail: { amount_paise: rupeesToPaise(b.amount), reason: b.reason ?? null, reference: b.reference ?? null, legs: result.legs } });
    res.status(201).json({ chargeback_id: result.id, legs: result.legs });
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
// Home-page service catalog (marketing cards shown on the landing site)
// ---------------------------------------------------------------------
router.get(
  '/site/services',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query(
      'SELECT id, code, icon, title, subtitle, category, sort_order, visible, terms, updated_at FROM site_services ORDER BY sort_order, id',
    );
    res.json({ items: rows });
  }),
);

const siteServiceSchema = z.object({
  icon: z.string().trim().min(1).max(300).default('💠'),
  title: z.string().trim().min(2).max(120),
  subtitle: z.string().trim().max(300).default(''),
  category: z.enum(['bank', 'bill', 'pay', 'more']).default('more'),
  sort_order: z.coerce.number().int().min(0).max(9999).default(0),
  visible: z.boolean().default(true),
  code: z.string().trim().max(40).optional(),
  terms: z.string().max(20000).default(''),
});

router.post(
  '/site/services',
  validate(siteServiceSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof siteServiceSchema>;
    const { rows } = await query(
      `INSERT INTO site_services (icon, title, subtitle, category, sort_order, visible, code, terms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, code, icon, title, subtitle, category, sort_order, visible, terms, updated_at`,
      [b.icon, b.title, b.subtitle, b.category, b.sort_order, b.visible, b.code ?? null, b.terms],
    );
    res.status(201).json({ item: rows[0] });
  }),
);

router.put(
  '/site/services/:id',
  validate(siteServiceSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof siteServiceSchema>;
    const { rows } = await query(
      `UPDATE site_services
          SET icon = $1, title = $2, subtitle = $3, category = $4,
              sort_order = $5, visible = $6, code = $7, terms = $8, updated_at = now()
        WHERE id = $9
       RETURNING id, code, icon, title, subtitle, category, sort_order, visible, terms, updated_at`,
      [b.icon, b.title, b.subtitle, b.category, b.sort_order, b.visible, b.code ?? null, b.terms, req.params.id],
    );
    if (!rows[0]) throw ApiError.notFound('Service not found');
    res.json({ item: rows[0] });
  }),
);

router.delete(
  '/site/services/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { rowCount } = await query('DELETE FROM site_services WHERE id = $1', [req.params.id]);
    if (!rowCount) throw ApiError.notFound('Service not found');
    res.status(204).send();
  }),
);

// ---------------------------------------------------------------------
// Account deletion requests (self-serve, actioned by an admin)
// ---------------------------------------------------------------------
router.get(
  '/deletion-requests',
  asyncHandler(async (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const { rows } = await query(
      `SELECT d.id, d.user_id, d.reason, d.status, d.admin_note, d.created_at, d.processed_at,
              u.full_name, u.email, u.phone, u.username, u.role
         FROM account_deletion_requests d JOIN users u ON u.id = d.user_id
        WHERE ($1 = 'all' OR d.status = $1)
        ORDER BY d.created_at DESC LIMIT 200`,
      [status],
    );
    res.json({ items: rows });
  }),
);

const processDeletionSchema = z.object({
  action: z.enum(['processed', 'rejected']),
  note: z.string().trim().max(1000).optional(),
});

router.post(
  '/deletion-requests/:id/process',
  validate(processDeletionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof processDeletionSchema>;
    const adminId = req.user?.id ?? null;
    const { rows } = await query(
      `UPDATE account_deletion_requests
          SET status = $1, admin_note = $2, processed_at = now(), processed_by = $3
        WHERE id = $4 AND status = 'pending'
       RETURNING id, status, admin_note, processed_at`,
      [b.action, b.note ?? '', adminId, req.params.id],
    );
    if (!rows[0]) throw ApiError.notFound('Request not found or already processed');
    res.json({ request: rows[0] });
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
              (api_secret IS NOT NULL AND api_secret <> '') AS has_secret,
              -- Non-sensitive SMTP settings so the email form can pre-fill.
              (extra->>'smtp_port')::int AS smtp_port,
              (extra->>'smtp_secure') = 'true' AS smtp_secure,
              extra->>'from_name' AS from_name
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

// Validate ANY integration's config. Email (SMTP) actually connects +
// authenticates; Telegram calls getMe; others check endpoint + key + active.
router.post(
  '/integrations/:key/validate',
  asyncHandler(async (req: Request, res: Response) => {
    const key = req.params.key;
    if (key === 'email') {
      const { validateEmailConfig } = await import('../notify/notify.service');
      res.json(await validateEmailConfig());
      return;
    }
    if (key === 'telegram') {
      const { rows } = await query<{ api_key: string | null; is_active: boolean; extra: Record<string, unknown> | null }>(
        "SELECT api_key, is_active, extra FROM platform_integrations WHERE key = 'telegram'",
      );
      const r = rows[0];
      const token = (r?.api_key || '').trim();
      const chatId = String((r?.extra?.chat_id as string) || '').trim();
      const missing: string[] = [];
      if (!token) missing.push('Bot token (API key)');
      if (!chatId) missing.push('Chat ID (Advanced config: {"chat_id":"…"})');
      if (missing.length) { res.json({ ok: false, active: !!r?.is_active, missing }); return; }
      const { telegramGetMe } = await import('../backup/telegram');
      const me = await telegramGetMe(token);
      res.json(me.ok
        ? { ok: true, active: !!r?.is_active, provider: `@${me.username}`, missing: [], note: r?.is_active ? undefined : 'Configured but not Active.' }
        : { ok: false, active: !!r?.is_active, missing: [], error: me.error });
      return;
    }
    const { rows } = await query<{ provider: string | null; base_url: string | null; is_active: boolean; has_key: boolean }>(
      `SELECT provider, base_url, is_active, (api_key IS NOT NULL AND api_key <> '') AS has_key
         FROM platform_integrations WHERE key = $1`,
      [key],
    );
    const r = rows[0];
    if (!r) throw ApiError.notFound('Integration not found');
    const keyless = ['ifsc_lookup', 'pincode'].includes(key);
    const missing: string[] = [];
    if (!r.base_url) missing.push('Base URL / endpoint');
    if (!r.has_key && !keyless) missing.push('API key');
    res.json({
      ok: missing.length === 0,
      active: r.is_active,
      provider: r.provider,
      missing,
      note: missing.length === 0 && !r.is_active ? 'Configured but not Active — turn it on to use it.' : undefined,
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
            SET status = 'approved', approval_mode = 'admin', reviewed_by = $1, reviewed_at = now(),
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

// Provision step of the "Add API from docs" wizard: after the config is drafted
// and dry-run tested, create a `dynamic` provider for each chosen service from
// one config, optionally auto-create its marketing/panel service tile, and
// optionally activate it — no developer, no deploy.
const provisionSchema = z.object({
  label: z.string().trim().min(2).max(120),
  services: z.array(z.string().trim().min(1).max(40)).min(1).max(14),
  config: z.record(z.any()),
  creds: z.object({
    base_url: z.string().trim().max(300).optional(),
    api_key: z.string().trim().max(300).optional(),
    api_secret: z.string().trim().max(300).optional(),
    auth_token: z.string().trim().max(600).optional(),
    partner_id: z.string().trim().max(120).optional(),
    webhook_secret: z.string().trim().max(300).optional(),
  }).optional(),
  create_tiles: z.boolean().default(true),
  activate: z.boolean().default(false),
});
router.post(
  '/integrations/provision',
  validate(provisionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof provisionSchema>;
    const c = b.creds ?? {};

    // Only attach to services that actually exist in the catalog.
    const known = await query<{ code: string; name: string }>(
      'SELECT code, name FROM services WHERE code = ANY($1)', [b.services],
    );
    const knownCodes = new Set(known.rows.map((r) => r.code));
    const unknown = b.services.filter((s) => !knownCodes.has(s));
    if (knownCodes.size === 0) throw ApiError.badRequest(`None of these are known services: ${b.services.join(', ')}`);

    const result = await withTransaction(async (client) => {
      const providers: unknown[] = [];
      const tiles: unknown[] = [];
      for (const row of known.rows) {
        const code = row.code;
        if (b.activate) {
          await client.query('UPDATE service_providers SET is_active = false WHERE service_code = $1 AND is_active = true', [code]);
        }
        const p = await client.query(
          `INSERT INTO service_providers
             (service_code, label, driver, base_url, api_key, api_secret, auth_token, partner_id, webhook_secret, extra, is_active, priority)
           VALUES ($1,$2,'dynamic',$3,$4,$5,$6,$7,$8,$9,$10,0) RETURNING id, service_code, label, driver, is_active`,
          [code, b.label, c.base_url ?? null, c.api_key ?? null, c.api_secret ?? null, c.auth_token ?? null,
            c.partner_id ?? null, c.webhook_secret ?? null, JSON.stringify(b.config), b.activate],
        );
        providers.push(p.rows[0]);
        if (b.create_tiles) {
          // One tile per service, if it doesn't already have one linked.
          const existing = await client.query('SELECT 1 FROM site_services WHERE code = $1', [code]);
          if (!existing.rowCount) {
            const t = await client.query(
              `INSERT INTO site_services (icon, title, subtitle, category, sort_order, visible, code)
               VALUES ('💠', $1, $2, 'more', 100, true, $3) RETURNING id, code, title`,
              [row.name || code, `${b.label} — ${row.name || code}`, code],
            );
            tiles.push(t.rows[0]);
          }
        }
      }
      return { providers, tiles };
    });
    await refreshProviderRegistry();
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'integration.provision',
      targetType: 'service_provider', targetId: b.label, detail: { services: [...knownCodes], activated: b.activate, tiles: result.tiles.length } });
    res.status(201).json({ ...result, skipped: unknown });
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

// ---------------------------------------------------------------------
// Provider Connections — configure ONE credential set once and fan it out
// across many services (e.g. Eko → DMT + AEPS + BBPS + Recharge). Each
// connection is a group of service_providers rows sharing a connection_id.
// ---------------------------------------------------------------------
router.get(
  '/provider-connections',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query(
      `SELECT connection_id,
              max(connection_label) AS label,
              max(driver) AS driver,
              max(base_url) AS base_url,
              max(partner_id) AS partner_id,
              (array_agg(extra ORDER BY created_at))[1] AS extra,
              bool_or(api_key IS NOT NULL AND api_key <> '') AS has_key,
              bool_or(api_secret IS NOT NULL AND api_secret <> '') AS has_secret,
              bool_or(auth_token IS NOT NULL AND auth_token <> '') AS has_token,
              min(created_at) AS created_at,
              json_agg(json_build_object('id', id, 'service_code', service_code, 'is_active', is_active) ORDER BY service_code) AS services
         FROM service_providers
        WHERE connection_id IS NOT NULL
        GROUP BY connection_id
        ORDER BY min(created_at) DESC`,
    );
    res.json({ items: rows });
  }),
);

const connectionSchema = z.object({
  label: z.string().trim().min(2).max(120),
  driver: z.enum(['sandbox', 'aggregator', 'razorpay', 'generic', 'aeronpay', 'eko', 'dynamic']).default('sandbox'),
  base_url: z.string().trim().max(300).optional(),
  api_key: z.string().trim().max(300).optional(),
  api_secret: z.string().trim().max(300).optional(),
  auth_token: z.string().trim().max(600).optional(),
  partner_id: z.string().trim().max(120).optional(),
  extra: z.record(z.any()).optional(),
  service_codes: z.array(z.string().trim().min(1).max(40)).min(1),
  activate: z.boolean().default(true),
});

router.post(
  '/provider-connections',
  validate(connectionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof connectionSchema>;
    const connId = await withTransaction(async (client) => {
      const idr = await client.query<{ id: string }>('SELECT gen_random_uuid() AS id');
      const id = idr.rows[0].id;
      for (const code of b.service_codes) {
        const svc = await client.query('SELECT 1 FROM services WHERE code = $1', [code]);
        if (!svc.rowCount) throw ApiError.badRequest(`Unknown service: ${code}`);
        if (b.activate) {
          await client.query('UPDATE service_providers SET is_active = false WHERE service_code = $1 AND is_active = true', [code]);
        }
        await client.query(
          `INSERT INTO service_providers
             (service_code, label, driver, base_url, api_key, api_secret, auth_token, partner_id, extra, is_active, connection_id, connection_label)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [code, b.label, b.driver, b.base_url ?? null, b.api_key ?? null, b.api_secret ?? null,
           b.auth_token ?? null, b.partner_id ?? null, JSON.stringify(b.extra ?? {}), b.activate, id, b.label],
        );
      }
      return id;
    });
    await refreshProviderRegistry();
    if (req.user) await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'provider.connect',
      targetType: 'provider_connection', targetId: connId, detail: { driver: b.driver, services: b.service_codes } });
    res.status(201).json({ connection_id: connId });
  }),
);

const connectionUpdateSchema = z.object({
  label: z.string().trim().min(2).max(120).optional(),
  base_url: z.string().trim().max(300).optional(),
  api_key: z.string().trim().max(300).optional(),
  api_secret: z.string().trim().max(300).optional(),
  auth_token: z.string().trim().max(600).optional(),
  partner_id: z.string().trim().max(120).optional(),
  extra: z.record(z.any()).optional(),
  service_codes: z.array(z.string().trim().min(1).max(40)).min(1).optional(),
  activate: z.boolean().optional(),
});

router.put(
  '/provider-connections/:id',
  validate(connectionUpdateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof connectionUpdateSchema>;
    const connId = req.params.id;
    // blank string / undefined = keep existing credential.
    const keep = (v?: string) => (v === undefined || v === '' ? null : v);
    await withTransaction(async (client) => {
      const cur = await client.query<{ id: string; service_code: string; is_active: boolean }>(
        'SELECT id, service_code, is_active FROM service_providers WHERE connection_id = $1', [connId]);
      if (!cur.rows.length) throw ApiError.notFound('Connection not found');
      await client.query(
        `UPDATE service_providers SET
            connection_label = COALESCE($1, connection_label),
            label = COALESCE($1, label),
            base_url = COALESCE($2, base_url),
            api_key = COALESCE($3, api_key),
            api_secret = COALESCE($4, api_secret),
            auth_token = COALESCE($5, auth_token),
            partner_id = COALESCE($6, partner_id),
            extra = COALESCE($7, extra),
            updated_at = now()
          WHERE connection_id = $8`,
        [keep(b.label), keep(b.base_url), keep(b.api_key), keep(b.api_secret), keep(b.auth_token),
         keep(b.partner_id), b.extra === undefined ? null : JSON.stringify(b.extra), connId],
      );
      if (b.service_codes) {
        const existing = new Set(cur.rows.map((r) => r.service_code));
        const wanted = new Set(b.service_codes);
        const protoId = cur.rows[0].id;
        for (const code of b.service_codes) {
          if (existing.has(code)) continue;
          const svc = await client.query('SELECT 1 FROM services WHERE code = $1', [code]);
          if (!svc.rowCount) throw ApiError.badRequest(`Unknown service: ${code}`);
          const active = b.activate ?? cur.rows[0].is_active;
          if (active) await client.query('UPDATE service_providers SET is_active=false WHERE service_code=$1 AND is_active=true', [code]);
          await client.query(
            `INSERT INTO service_providers (service_code, label, driver, base_url, api_key, api_secret, auth_token, partner_id, extra, is_active, connection_id, connection_label)
             SELECT $1, connection_label, driver, base_url, api_key, api_secret, auth_token, partner_id, extra, $2, connection_id, connection_label
               FROM service_providers WHERE id = $3`,
            [code, active, protoId],
          );
        }
        for (const code of existing) {
          if (!wanted.has(code)) await client.query('DELETE FROM service_providers WHERE connection_id=$1 AND service_code=$2', [connId, code]);
        }
      }
      if (b.activate !== undefined) {
        if (b.activate) {
          const svcRows = await client.query<{ service_code: string }>('SELECT service_code FROM service_providers WHERE connection_id=$1', [connId]);
          for (const r of svcRows.rows) {
            await client.query('UPDATE service_providers SET is_active=false WHERE service_code=$1 AND is_active=true AND connection_id IS DISTINCT FROM $2', [r.service_code, connId]);
          }
        }
        await client.query('UPDATE service_providers SET is_active=$1 WHERE connection_id=$2', [b.activate, connId]);
      }
    });
    await refreshProviderRegistry();
    res.json({ connection_id: connId });
  }),
);

router.post(
  '/provider-connections/:id/activate',
  asyncHandler(async (req: Request, res: Response) => {
    await withTransaction(async (client) => {
      const svcRows = await client.query<{ service_code: string }>('SELECT service_code FROM service_providers WHERE connection_id=$1', [req.params.id]);
      if (!svcRows.rows.length) throw ApiError.notFound('Connection not found');
      for (const r of svcRows.rows) {
        await client.query('UPDATE service_providers SET is_active=false WHERE service_code=$1 AND is_active=true AND connection_id IS DISTINCT FROM $2', [r.service_code, req.params.id]);
      }
      await client.query('UPDATE service_providers SET is_active=true WHERE connection_id=$1', [req.params.id]);
    });
    await refreshProviderRegistry();
    res.json({ ok: true });
  }),
);

router.post(
  '/provider-connections/:id/deactivate',
  asyncHandler(async (req: Request, res: Response) => {
    const { rowCount } = await query('UPDATE service_providers SET is_active=false WHERE connection_id=$1', [req.params.id]);
    if (!rowCount) throw ApiError.notFound('Connection not found');
    await refreshProviderRegistry();
    res.json({ ok: true });
  }),
);

router.post(
  '/provider-connections/:id/test',
  asyncHandler(async (req: Request, res: Response) => {
    const { rows } = await query(
      `SELECT id, service_code, label, driver, base_url, api_key, api_secret, auth_token, partner_id, is_active
         FROM service_providers WHERE connection_id=$1 ORDER BY created_at LIMIT 1`,
      [req.params.id],
    );
    if (!rows[0]) throw ApiError.notFound('Connection not found');
    const { probeProvider } = await import('../../providers/health');
    const result = await probeProvider(rows[0] as never);
    res.json({ result });
  }),
);

router.delete(
  '/provider-connections/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { rowCount } = await query('DELETE FROM service_providers WHERE connection_id=$1', [req.params.id]);
    if (!rowCount) throw ApiError.notFound('Connection not found');
    await refreshProviderRegistry();
    res.status(204).send();
  }),
);

// ---- Admin broadcast: message a member audience over SMS/WhatsApp/Email ----
const broadcastSchema = z.object({
  subject: z.string().trim().max(120).optional(),
  message: z.string().trim().min(3).max(1000),
  channels: z.array(z.enum(['sms', 'whatsapp', 'email'])).min(1),
  audience: z.enum(['all', 'retailer', 'distributor', 'master_distributor']).default('all'),
});
// Preview the recipient count for an audience before sending.
router.get(
  '/broadcasts/recipients',
  validate(z.object({ audience: z.enum(['all', 'retailer', 'distributor', 'master_distributor']).default('all') }), 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const { audience } = req.query as unknown as { audience: 'all' | 'retailer' | 'distributor' | 'master_distributor' };
    const { countRecipients } = await import('../broadcast/broadcast.service');
    res.json({ audience, count: await countRecipients(audience) });
  }),
);
router.get(
  '/broadcasts',
  asyncHandler(async (_req: Request, res: Response) => {
    const { listBroadcasts } = await import('../broadcast/broadcast.service');
    res.json({ items: await listBroadcasts() });
  }),
);
router.post(
  '/broadcasts',
  validate(broadcastSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof broadcastSchema>;
    const { createBroadcast } = await import('../broadcast/broadcast.service');
    const broadcast = await createBroadcast({ ...b, createdBy: req.user.id });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'broadcast.send',
      targetType: 'broadcast', targetId: broadcast.id, detail: { audience: b.audience, channels: b.channels, total: broadcast.total } });
    res.status(201).json({ broadcast });
  }),
);

// ---- Rewards: referral report + milestone/prize-draw campaigns -------------
router.get(
  '/referrals',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query(
      `SELECT r.id, r.status, r.bonus_paise, r.created_at, r.rewarded_at,
              ru.full_name AS referrer_name, ru.phone AS referrer_phone,
              nu.full_name AS referred_name, nu.phone AS referred_phone
         FROM referrals r
         JOIN users ru ON ru.id = r.referrer_id
         JOIN users nu ON nu.id = r.referred_id
        ORDER BY r.created_at DESC LIMIT 200`,
    );
    res.json({ items: rows });
  }),
);

const campaignSchema = z.object({
  name: z.string().trim().min(2).max(120),
  metric: z.enum(['count', 'gtv']),
  target: z.coerce.number().positive(),                 // count, or rupees for gtv
  from_date: z.string().trim(),
  to_date: z.string().trim(),
  reward_type: z.enum(['cashback', 'draw']),
  reward: z.coerce.number().min(0),                     // rupees per qualifier / winner
  winners: z.coerce.number().int().min(1).max(1000).default(1),
});
router.get(
  '/campaigns',
  asyncHandler(async (_req: Request, res: Response) => {
    const { listCampaigns } = await import('../rewards/campaign.service');
    res.json({ items: await listCampaigns() });
  }),
);
router.post(
  '/campaigns',
  validate(campaignSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof campaignSchema>;
    const { createCampaign } = await import('../rewards/campaign.service');
    // gtv target + rewards are entered in rupees; store paise.
    const c = await createCampaign({
      name: b.name, metric: b.metric,
      target: b.metric === 'gtv' ? Math.round(b.target * 100) : Math.round(b.target),
      from_date: b.from_date, to_date: b.to_date,
      reward_type: b.reward_type, reward_paise: Math.round(b.reward * 100), winners: b.winners,
      createdBy: req.user.id,
    });
    res.status(201).json({ campaign: c });
  }),
);
router.get(
  '/campaigns/:id/eligible',
  asyncHandler(async (req: Request, res: Response) => {
    const { qualifiers } = await import('../rewards/campaign.service');
    const items = await qualifiers(req.params.id);
    res.json({ count: items.length, items });
  }),
);
router.post(
  '/campaigns/:id/award',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { awardCampaign } = await import('../rewards/campaign.service');
    const winners = await awardCampaign(req.params.id);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'campaign.award',
      targetType: 'campaign', targetId: req.params.id, detail: { winners: winners.length } });
    res.json({ winners });
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
      'SELECT key, name, website, services, suggested_driver, base_url, default_services, notes FROM provider_directory WHERE enabled = true ORDER BY sort_order, name',
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

// ---------------------------------------------------------------------
// Disaster-recovery backup to Telegram (daily DB dump + optional .env).
// ---------------------------------------------------------------------
router.get(
  '/backup/status',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query<{ key: string; value: string | null }>(
      "SELECT key, value FROM site_settings WHERE key IN ('backup_daily_hour','backup_include_env','backup_last_date','backup_last_status')",
    );
    const s: Record<string, string> = {};
    rows.forEach((r) => { s[r.key] = r.value ?? ''; });
    let last: unknown = null;
    try { last = s.backup_last_status ? JSON.parse(s.backup_last_status) : null; } catch { last = null; }
    const tg = await query<{ is_active: boolean }>("SELECT is_active FROM platform_integrations WHERE key = 'telegram'");
    res.json({
      telegram_active: !!tg.rows[0]?.is_active,
      daily_hour: s.backup_daily_hour === '' ? null : Number(s.backup_daily_hour),
      include_env: s.backup_include_env === 'true',
      last_date: s.backup_last_date || null,
      last_status: last,
    });
  }),
);

router.put(
  '/backup/settings',
  validate(z.object({
    daily_hour: z.number().int().min(0).max(23).nullable().optional(),
    include_env: z.boolean().optional(),
  })),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as { daily_hour?: number | null; include_env?: boolean };
    const upsert = async (key: string, value: string) => query(
      `INSERT INTO site_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
    if (b.daily_hour !== undefined) await upsert('backup_daily_hour', b.daily_hour === null ? '' : String(b.daily_hour));
    if (b.include_env !== undefined) await upsert('backup_include_env', b.include_env ? 'true' : 'false');
    await logAudit({ actorId: req.user?.id, actorRole: req.user?.role, action: 'backup.settings',
      targetType: 'site_settings', targetId: 'backup', detail: { daily_hour: b.daily_hour, include_env: b.include_env } });
    res.json({ ok: true });
  }),
);

router.post(
  '/backup/run',
  validate(z.object({ include_env: z.boolean().optional() })),
  asyncHandler(async (req: Request, res: Response) => {
    const { runBackup } = await import('../backup/backup.service');
    await logAudit({ actorId: req.user?.id, actorRole: req.user?.role, action: 'backup.run', targetType: 'backup', targetId: 'manual', detail: {} });
    const r = await runBackup({ includeEnv: (req.body as { include_env?: boolean }).include_env });
    res.json(r);
  }),
);

router.post(
  '/backup/test-telegram',
  asyncHandler(async (_req: Request, res: Response) => {
    const { telegramConfig, sendTelegramMessage } = await import('../backup/telegram');
    const cfg = await telegramConfig();
    if (!cfg) { res.json({ ok: false, message: 'Telegram not configured/active. Add bot token + chat id in the API Hub.' }); return; }
    const ok = await sendTelegramMessage(cfg, '✅ TutiPays test message — your Telegram backup bot is connected.');
    res.json({ ok, message: ok ? 'Test message sent — check your Telegram.' : 'Failed — check the bot token and that the bot has been started / added to the chat.' });
  }),
);

// ---------------------------------------------------------------------
// AI advisor narrative — turns the deterministic Blueprint advisor findings
// into a prioritized, plain-language review using the configured AI model
// ('ai_coder'). Degrades gracefully: returns ai:false when no model is set.
// ---------------------------------------------------------------------
router.post(
  '/advisor/ai-review',
  validate(z.object({
    findings: z.array(z.object({
      level: z.string().trim().max(10),
      title: z.string().trim().max(200),
      detail: z.string().trim().max(800),
    })).min(1).max(40),
    context: z.string().trim().max(2000).optional(),
  })),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as { findings: Array<{ level: string; title: string; detail: string }>; context?: string };
    const system =
      'You are an operations, growth and compliance advisor for an Indian B2B fintech aggregator ' +
      '(services: recharge, BBPS, DMT, AePS, payout, travel, insurance, payment gateway, with a ' +
      'super-distributor → distributor → retailer network). You are given automated findings about ' +
      'the platform\'s live configuration. Write a concise, prioritized review for the admin with three ' +
      'short sections: "Do first" (the 2-3 most important actions and why), "Grow" (how to gain more ' +
      'business advantage from what is / isn\'t set up), and "Secure & comply" (security + AML posture). ' +
      'Be specific and practical, use short bullets, Indian context (RBI/KYC/TDS/GST where relevant). ' +
      'Base everything ONLY on the findings given — do not invent facts or numbers.';
    const user = 'Findings (level | title | detail):\n' +
      b.findings.map((f) => `- ${f.level} | ${f.title} | ${f.detail}`).join('\n') +
      (b.context ? `\n\nContext: ${b.context}` : '');
    const out = await aiChat(system, user);
    if (!out) {
      res.json({ ai: false, message: 'No AI model is configured. Set one in 🤖 AI Integration Studio to enable the narrative review (a free model works).' });
      return;
    }
    res.json({ ai: true, narrative: out });
  }),
);

// ---------------------------------------------------------------------
// AML / banned-business blocklist (Risk & AML). Admin-managed screening list;
// matched payees are blocked or flagged before a transaction commits.
// ---------------------------------------------------------------------
function normAmlValue(kind: string, value: string): string {
  const v = value.trim().toLowerCase();
  return kind === 'name' || kind === 'keyword' ? v.replace(/\s+/g, ' ') : v.replace(/\s+/g, '');
}

router.get(
  '/aml/blocklist',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query(
      'SELECT id, kind, value_norm, label, action, reason, is_active, created_at FROM aml_blocklist ORDER BY created_at DESC LIMIT 500',
    );
    res.json({ items: rows });
  }),
);

const amlSchema = z.object({
  kind: z.enum(['account', 'ifsc', 'upi', 'mobile', 'pan', 'name', 'keyword']),
  value: z.string().trim().min(2).max(200),
  action: z.enum(['block', 'flag']).default('block'),
  reason: z.string().trim().max(300).optional(),
});

router.post(
  '/aml/blocklist',
  validate(amlSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as z.infer<typeof amlSchema>;
    const valueNorm = normAmlValue(b.kind, b.value);
    const { rows } = await query(
      `INSERT INTO aml_blocklist (kind, value_norm, label, action, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (kind, value_norm) DO UPDATE SET
         label = EXCLUDED.label, action = EXCLUDED.action, reason = EXCLUDED.reason, is_active = true
       RETURNING id, kind, value_norm, label, action, reason, is_active, created_at`,
      [b.kind, valueNorm, b.value.trim(), b.action, b.reason ?? null, req.user?.id ?? null],
    );
    await logAudit({ actorId: req.user?.id, actorRole: req.user?.role, action: 'aml.blocklist.add',
      targetType: 'aml_blocklist', targetId: rows[0].id as string, detail: { kind: b.kind, action: b.action } });
    res.status(201).json({ entry: rows[0] });
  }),
);

router.patch(
  '/aml/blocklist/:id',
  validate(z.object({ is_active: z.boolean() })),
  asyncHandler(async (req: Request, res: Response) => {
    const { rows } = await query(
      'UPDATE aml_blocklist SET is_active = $2 WHERE id = $1 RETURNING id, is_active',
      [req.params.id, (req.body as { is_active: boolean }).is_active],
    );
    if (!rows[0]) throw ApiError.notFound('Entry not found');
    await logAudit({ actorId: req.user?.id, actorRole: req.user?.role, action: 'aml.blocklist.toggle',
      targetType: 'aml_blocklist', targetId: req.params.id, detail: { is_active: rows[0].is_active } });
    res.json({ entry: rows[0] });
  }),
);

router.delete(
  '/aml/blocklist/:id',
  asyncHandler(async (req: Request, res: Response) => {
    await query('DELETE FROM aml_blocklist WHERE id = $1', [req.params.id]);
    await logAudit({ actorId: req.user?.id, actorRole: req.user?.role, action: 'aml.blocklist.delete',
      targetType: 'aml_blocklist', targetId: req.params.id, detail: {} });
    res.json({ ok: true });
  }),
);

// Recent AML flags/blocks (from the risk event log).
router.get(
  '/aml/flags',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query(
      `SELECT r.id, r.user_id, u.full_name AS member_name, r.service_code, r.reference, r.action, r.score, r.detail, r.created_at
         FROM risk_events r LEFT JOIN users u ON u.id = r.user_id
        WHERE r.kind = 'aml_blocklist'
        ORDER BY r.created_at DESC LIMIT 100`,
    );
    res.json({ items: rows });
  }),
);

// ---------------------------------------------------------------------
// Webhook self-test — fire a signed sample callback at a provider's OWN
// callback URL (locally) and report whether it was accepted. Uses a sentinel
// reference so settlement finds no transaction and nothing moves; the attempt
// shows in the webhook monitor. Exercises the real auth path (HMAC / Basic),
// so it proves the callback security config end-to-end. Secret never leaves
// the server.
// ---------------------------------------------------------------------
async function selfPostWebhook(path: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: env.PORT, path, method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, timeout: 5000 },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data.slice(0, 1000) }));
      },
    );
    req.on('error', (e) => resolve({ status: 0, body: String((e as Error).message) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout reaching local API' }); });
    req.write(body);
    req.end();
  });
}

router.post(
  '/providers/:id/test-webhook',
  asyncHandler(async (req: Request, res: Response) => {
    const { rows } = await query<{ label: string; service_code: string; webhook_secret: string | null; extra: Record<string, unknown> | null }>(
      'SELECT label, service_code, webhook_secret, extra FROM service_providers WHERE id = $1',
      [req.params.id],
    );
    const p = rows[0];
    if (!p) throw ApiError.notFound('Provider not found');
    const extra = p.extra ?? {};
    const mode = String((extra.webhook_auth as string) ?? 'hmac').toLowerCase();
    const reference = 'SELFTEST-' + crypto.randomUUID();
    const payload = JSON.stringify({ reference, status: 'success', amount: 1, service: p.service_code, message: 'TutiPays webhook self-test', test: true });
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    if (mode === 'hmac') {
      let secret = (p.webhook_secret || '').trim();
      if (!secret) {
        const g = await query<{ value: string }>("SELECT value FROM site_settings WHERE key = 'aggregator_webhook_secret'");
        secret = (g.rows[0]?.value || '').trim();
      }
      if (!secret) {
        res.json({ ok: false, auth_mode: mode, reason: 'No webhook secret set for this provider (and no global secret). Set a secret before going live, or your real callbacks will be rejected.' });
        return;
      }
      headers['x-webhook-signature'] = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    } else if (mode === 'basic') {
      const user = String((extra.webhook_user as string) ?? ''); const pass = String((extra.webhook_pass as string) ?? '');
      if (!user || !pass) { res.json({ ok: false, auth_mode: mode, reason: 'Basic-auth webhook has no user/pass configured.' }); return; }
      headers['authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    } else if (mode === 'ip') {
      const raw = extra.webhook_ips;
      const list = (Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(',')).map((s) => s.trim()).filter(Boolean);
      res.json({ ok: list.length > 0, auth_mode: mode, skipped: true,
        reason: list.length
          ? `IP-allowlist mode (${list.length} entr${list.length === 1 ? 'y' : 'ies'}). A server self-test posts from 127.0.0.1, which your allowlist would reject — a real call from the provider's IPs is what proves this path. Config looks set.`
          : 'IP-allowlist mode but no IPs configured — add the provider\'s callback IPs/CIDRs.' });
      return;
    } // 'none' → post with no auth (insecure; reported below)

    await logAudit({ actorId: req.user?.id, actorRole: req.user?.role, action: 'webhook.selftest', targetType: 'service_provider', targetId: req.params.id, detail: { mode } });
    const out = await selfPostWebhook(`/api/v1/webhooks/provider/${req.params.id}`, payload, headers);
    const ok = out.status >= 200 && out.status < 300;
    res.json({
      ok, auth_mode: mode, http_status: out.status, reference, response: out.body,
      insecure: mode === 'none',
      reason: ok
        ? (mode === 'none' ? 'Accepted — but this provider has NO webhook auth (mode "none"). Anyone who learns the URL could post. Add HMAC/Basic/IP auth.' : 'Accepted — your callback URL, raw-body parsing and signature verification all work. (No transaction matched the test reference, so nothing settled.)')
        : out.status === 0 ? `Could not reach the API locally: ${out.body}` : `Rejected (HTTP ${out.status}). Check the secret/credentials match what the provider will send. ${out.body}`,
    });
  }),
);

export default router;
