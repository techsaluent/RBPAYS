import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';
import { kycRequirementsFor } from './onboarding.service';

/** Member-facing onboarding: KYC checklist, device binding, shop geotag. */
const router = Router();
router.use(requireAuth);

// What KYC documents my role must submit, and which I've done.
router.get(
  '/requirements',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const items = await kycRequirementsFor(req.user.id, req.user.role);
    const pending = items.filter((i) => i.mandatory && !i.verified).length;
    res.json({ role: req.user.role, requirements: items, mandatory_pending: pending });
  }),
);

const deviceSchema = z.object({
  device_uuid: z.string().trim().min(4).max(128),
  label: z.string().trim().max(80).optional(),
  imei: z.string().trim().max(32).optional(),
});

// Bind a device (IMEI/UUID) to my account.
router.post(
  '/device',
  validate(deviceSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof deviceSchema>;
    const { rows } = await query(
      `INSERT INTO member_devices (user_id, device_uuid, label, imei)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, device_uuid) DO UPDATE SET label = EXCLUDED.label, imei = EXCLUDED.imei, is_active = true
       RETURNING id, device_uuid, label, is_active, bound_at`,
      [req.user.id, b.device_uuid, b.label ?? null, b.imei ?? null],
    );
    res.status(201).json({ device: rows[0] });
  }),
);

router.get(
  '/devices',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rows } = await query(
      'SELECT id, device_uuid, label, imei, is_active, bound_at FROM member_devices WHERE user_id = $1 ORDER BY bound_at DESC',
      [req.user.id],
    );
    res.json({ items: rows });
  }),
);

const shopSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius_m: z.coerce.number().int().min(50).max(20000).default(5000),
});

// Geotag my shop (used for the operating geofence).
router.post(
  '/shop-location',
  validate(shopSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof shopSchema>;
    const { rows } = await query(
      'UPDATE users SET shop_lat=$1, shop_lng=$2, geofence_radius_m=$3 WHERE id=$4 RETURNING shop_lat, shop_lng, geofence_radius_m',
      [b.lat, b.lng, b.radius_m, req.user.id],
    );
    res.json({ shop: rows[0] });
  }),
);

export default router;
