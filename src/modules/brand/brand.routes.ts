import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { logAudit } from '../audit/audit.service';
import {
  requireOwnedTenantId, getTenant, updateTenant,
  listDomains, addDomain, verifyDomain, deleteDomain,
  tenantServiceMatrix, setTenantServiceVisibility,
  listSubTenants, createSubTenant, setTenantSetting,
} from '../tenant/tenant.service';
import { resellerEarningsForPeriod, generateResellerInvoice, listInvoices, partnerDashboard } from '../tenant/tenant.billing.service';

/**
 * Self-service white-label brand console (Sec2Pay-style): a partner who OWNS a
 * tenant manages their own branding, custom domains and service visibility
 * from their panel — no super-admin needed. Every operation is scoped to the
 * caller's own tenant: the tenant id is derived from owner_user_id server-side,
 * never taken from the client, so a partner can only ever touch their own brand.
 * Status and ownership are NOT editable here (only the super-admin sets those).
 */
const router = Router();
router.use(requireAuth);

// Branding fields a partner may edit on their own tenant (no status/owner).
const brandingSchema = z.object({
  brand_name: z.string().trim().min(1).max(80).optional(),
  logo_url: z.string().trim().max(500).nullable().optional(),
  logo_emoji: z.string().trim().max(16).nullable().optional(),
  primary_color: z.string().trim().max(32).nullable().optional(),
  tagline: z.string().trim().max(160).nullable().optional(),
  support_email: z.string().trim().max(120).nullable().optional(),
  support_phone: z.string().trim().max(20).nullable().optional(),
  company_name: z.string().trim().max(120).nullable().optional(),
});

async function myTenantId(req: Request): Promise<string> {
  if (!req.user) throw ApiError.unauthorized();
  return requireOwnedTenantId(req.user.id);
}

// My brand (tenant) + a hint for the panel.
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const id = await myTenantId(req);
  res.json({ tenant: await getTenant(id) });
}));

// Partner dashboard: brand GTV, members, sub-brands, partner share owed.
router.get('/dashboard', asyncHandler(async (req: Request, res: Response) => {
  const id = await myTenantId(req);
  res.json({ tenant: await getTenant(id), dashboard: await partnerDashboard(id) });
}));

router.put('/', validate(brandingSchema), asyncHandler(async (req: Request, res: Response) => {
  const id = await myTenantId(req);
  // Only branding fields reach updateTenant — status/owner stay untouched.
  const t = await updateTenant(id, req.body as z.infer<typeof brandingSchema>);
  await logAudit({ actorId: req.user!.id, actorRole: req.user!.role, action: 'brand.update',
    targetType: 'tenant', targetId: id, detail: req.body });
  res.json({ tenant: t });
}));

// ---- My custom domains --------------------------------------------------
router.get('/domains', asyncHandler(async (req: Request, res: Response) => {
  res.json({ items: await listDomains(await myTenantId(req)) });
}));

router.post('/domains', validate(z.object({ domain: z.string().trim().min(3).max(255) })),
  asyncHandler(async (req: Request, res: Response) => {
    const id = await myTenantId(req);
    const d = await addDomain(id, (req.body as { domain: string }).domain);
    await logAudit({ actorId: req.user!.id, actorRole: req.user!.role, action: 'brand.domain.add',
      targetType: 'tenant', targetId: id, detail: { domain: d.domain } });
    res.status(201).json({ domain: d });
  }));

router.post('/domains/:domainId/verify', asyncHandler(async (req: Request, res: Response) => {
  const id = await myTenantId(req);
  res.json(await verifyDomain(id, req.params.domainId));
}));

router.delete('/domains/:domainId', asyncHandler(async (req: Request, res: Response) => {
  const id = await myTenantId(req);
  await deleteDomain(id, req.params.domainId);
  res.status(204).send();
}));

// ---- Which of my services show on my brand ------------------------------
router.get('/services', asyncHandler(async (req: Request, res: Response) => {
  res.json({ items: await tenantServiceMatrix(await myTenantId(req)) });
}));

router.put('/services/:code', validate(z.object({ visible: z.boolean() })),
  asyncHandler(async (req: Request, res: Response) => {
    const id = await myTenantId(req);
    await setTenantServiceVisibility(id, req.params.code, (req.body as { visible: boolean }).visible);
    res.json({ ok: true });
  }));

// ---- Reseller: my sub-brands + earnings (multi-level white-label) --------
const subTenantSchema = z.object({
  brand_name: z.string().trim().min(1).max(80),
  owner_user_id: z.string().uuid(), // must be in my downline — enforced server-side
  logo_url: z.string().trim().max(500).nullable().optional(),
  logo_emoji: z.string().trim().max(16).nullable().optional(),
  primary_color: z.string().trim().max(32).nullable().optional(),
  tagline: z.string().trim().max(160).nullable().optional(),
  support_email: z.string().trim().max(120).nullable().optional(),
  support_phone: z.string().trim().max(20).nullable().optional(),
  company_name: z.string().trim().max(120).nullable().optional(),
  partner_share_bps: z.coerce.number().int().min(0).max(10000).optional(),
});
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

router.get('/sub-tenants', asyncHandler(async (req: Request, res: Response) => {
  res.json({ items: await listSubTenants(await myTenantId(req)) });
}));

router.post('/sub-tenants', validate(subTenantSchema), asyncHandler(async (req: Request, res: Response) => {
  const myId = await myTenantId(req);
  const body = req.body as z.infer<typeof subTenantSchema>;
  const t = await createSubTenant(req.user!.id, myId, body);
  await logAudit({ actorId: req.user!.id, actorRole: req.user!.role, action: 'brand.subtenant.create',
    targetType: 'tenant', targetId: t.id, detail: { brand_name: t.brand_name, owner: body.owner_user_id } });
  res.status(201).json({ sub_tenant: t });
}));

// Update a sub-brand I own (branding + the sub-partner's margin). Scoped: the
// target must be a direct sub-tenant of MY tenant.
router.put('/sub-tenants/:id',
  validate(brandingSchema.extend({ partner_share_bps: z.coerce.number().int().min(0).max(10000).optional() })),
  asyncHandler(async (req: Request, res: Response) => {
    const myId = await myTenantId(req);
    const sub = await getTenant(req.params.id);
    if (sub.parent_tenant_id !== myId) throw ApiError.forbidden('That brand is not one of your sub-brands');
    const body = req.body as z.infer<typeof brandingSchema> & { partner_share_bps?: number };
    const { partner_share_bps, ...branding } = body;
    if (Object.keys(branding).length) await updateTenant(sub.id, branding);
    if (partner_share_bps != null) await setTenantSetting(sub.id, 'partner_share_bps', String(partner_share_bps));
    await logAudit({ actorId: req.user!.id, actorRole: req.user!.role, action: 'brand.subtenant.update',
      targetType: 'tenant', targetId: sub.id, detail: body });
    res.json({ sub_tenant: await getTenant(sub.id) });
  }));

// My reseller earnings for a period (what the platform owes me on my sub-brands).
router.get('/reseller-earnings',
  validate(z.object({ from: isoDate, to: isoDate }), 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const myId = await myTenantId(req);
    const q = req.query as unknown as { from: string; to: string };
    res.json({ earnings: await resellerEarningsForPeriod(myId, q.from, q.to) });
  }));

// Generate a reseller-earnings statement (draft). The platform issues + settles it.
router.post('/reseller-statement',
  validate(z.object({ period_start: isoDate, period_end: isoDate })),
  asyncHandler(async (req: Request, res: Response) => {
    const myId = await myTenantId(req);
    const b = req.body as { period_start: string; period_end: string };
    const result = await generateResellerInvoice(myId, b.period_start, b.period_end);
    await logAudit({ actorId: req.user!.id, actorRole: req.user!.role, action: 'brand.reseller.statement',
      targetType: 'tenant_invoice', targetId: result.invoice.id, detail: { period: [b.period_start, b.period_end], net_payable_paise: result.invoice.net_payable_paise } });
    res.status(201).json(result);
  }));

// My statements (both my own partner statements and my reseller-earnings ones).
router.get('/statements', asyncHandler(async (req: Request, res: Response) => {
  res.json({ items: await listInvoices(await myTenantId(req)) });
}));

export default router;
