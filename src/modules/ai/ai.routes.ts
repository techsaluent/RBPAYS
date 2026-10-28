import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';
import { resolveBranding } from '../tenant/tenant.service';
import { generateMarketingPosts } from './marketing.service';

/**
 * Member-facing AI studio. Right now: the marketing-post generator so a member
 * can promote their services without a marketing team (AI copy when the admin
 * has configured an AI endpoint, branded templates otherwise — always free to
 * use). Posts come back on the member's own white-label brand.
 */
const router = Router();
router.use(requireAuth);

// Services the member has active, for the marketing service picker.
router.get(
  '/marketing/services',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rows } = await query<{ service_code: string }>(
      `SELECT us.service_code
         FROM user_services us
         JOIN services s ON s.code = us.service_code
        WHERE us.user_id = $1 AND us.active = true AND s.enabled = true
        ORDER BY us.service_code`,
      [req.user.id],
    );
    res.json({ services: rows.map((r) => r.service_code) });
  }),
);

const genSchema = z.object({
  service: z.string().trim().min(2).max(40),
  offer: z.string().trim().max(160).optional(),
  tone: z.enum(['friendly', 'festive', 'urgent', 'professional']).optional(),
});

// Generate on-brand marketing posts for one of the member's services.
router.post(
  '/marketing/generate',
  validate(genSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof genSchema>;

    // The member must actually hold the service they want to promote.
    const held = await query(
      'SELECT 1 FROM user_services WHERE user_id = $1 AND service_code = $2 AND active = true',
      [req.user.id, b.service],
    );
    if (!held.rowCount) throw ApiError.unprocessable('You do not have that service enabled.');

    const brand = await resolveBranding(req.user.id);
    const result = await generateMarketingPosts(
      {
        brand_name: brand.brand_name,
        tagline: brand.tagline,
        support_phone: brand.support_phone,
        support_email: brand.support_email,
        primary_color: brand.primary_color,
      },
      b.service,
      { offer: b.offer, tone: b.tone },
    );
    res.json(result);
  }),
);

export default router;
