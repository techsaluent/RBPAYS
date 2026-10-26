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
} from '../tenant/tenant.service';

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

export default router;
