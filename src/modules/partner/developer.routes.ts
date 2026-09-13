import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import {
  PARTNER_SERVICES, createKey, listKeys, updateKey, revokeKey, getCallbackSecret, listDeliveries,
} from './partner.service';

// Member-facing management of the partner/reseller API keys. JWT-authenticated
// (the member manages their own keys from the panel). The public reseller API
// itself lives under /partner and is authenticated by the key.
const router = Router();
router.use(requireAuth);

const scopesField = z.array(z.string().trim()).max(30).optional();
const ipsField = z.array(z.string().trim().max(45)).max(50).optional();

const createSchema = z.object({
  label: z.string().trim().max(80).optional(),
  environment: z.enum(['live', 'test']).default('live'),
  scopes: scopesField,
  allowed_ips: ipsField,
  rate_limit_per_min: z.coerce.number().int().min(1).max(6000).optional(),
  callback_url: z.string().trim().url().max(500).optional(),
});

const updateSchema = z.object({
  label: z.string().trim().max(80).optional(),
  scopes: scopesField,
  allowed_ips: ipsField,
  rate_limit_per_min: z.coerce.number().int().min(1).max(6000).optional(),
  callback_url: z.string().trim().url().max(500).nullable().optional(),
});

// The scopes a key can be granted (for the panel's scope picker).
router.get('/services', (_req: Request, res: Response) => {
  res.json({ services: PARTNER_SERVICES });
});

router.get(
  '/keys',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    res.json({ items: await listKeys(req.user.id) });
  }),
);

// Create a key — returns the raw key + signing secret ONCE.
router.post(
  '/keys',
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof createSchema>;
    const key = await createKey({
      userId: req.user.id,
      label: b.label,
      environment: b.environment,
      scopes: b.scopes,
      allowedIps: b.allowed_ips,
      rateLimitPerMin: b.rate_limit_per_min,
      callbackUrl: b.callback_url ?? null,
    });
    res.status(201).json({ key });
  }),
);

router.put(
  '/keys/:id',
  validate(updateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof updateSchema>;
    const key = await updateKey(req.user.id, req.params.id, {
      label: b.label,
      scopes: b.scopes,
      allowedIps: b.allowed_ips,
      rateLimitPerMin: b.rate_limit_per_min,
      callbackUrl: b.callback_url,
    });
    res.json({ key });
  }),
);

// Reveal the callback signing secret (needed to verify webhook signatures).
router.get(
  '/keys/:id/secret',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    res.json({ callback_secret: await getCallbackSecret(req.user.id, req.params.id) });
  }),
);

router.delete(
  '/keys/:id',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    await revokeKey(req.user.id, req.params.id);
    res.json({ revoked: true });
  }),
);

// Outbound-callback delivery log.
router.get(
  '/deliveries',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    res.json({ items: await listDeliveries(req.user.id) });
  }),
);

export default router;
