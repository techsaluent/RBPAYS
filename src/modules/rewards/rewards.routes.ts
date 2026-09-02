import { Request, Response, Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { myReferral } from './referral.service';
import { memberCampaigns } from './campaign.service';

/** Member-facing rewards: referral code/earnings + active reward campaigns. */
const router = Router();
router.use(requireAuth);

router.get(
  '/referral',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    res.json(await myReferral(req.user.id));
  }),
);

router.get(
  '/campaigns',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    res.json({ items: await memberCampaigns(req.user.id) });
  }),
);

export default router;
