import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { platformAnalytics, memberAnalytics } from './analytics.service';

const router = Router();
router.use(requireAuth);

const rangeSchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

// My earnings + activity analytics (any authenticated member).
router.get(
  '/me',
  validate(rangeSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { days } = req.query as unknown as { days: number };
    res.json(await memberAnalytics(req.user.id, days));
  }),
);

// Platform-wide analytics (admin / staff only).
router.get(
  '/platform',
  requireRole('admin', 'staff'),
  validate(rangeSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const { days } = req.query as unknown as { days: number };
    res.json(await platformAnalytics(days));
  }),
);

export default router;
