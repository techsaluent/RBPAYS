import { Request, Response, Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { listActiveProviders } from '../../providers/registry';

/**
 * Member-facing catalog. Lets the panel discover which providers are live for
 * a service so the retailer can pick one (e.g. Recharge 1 / Recharge 2) when
 * more than one is configured.
 */
const router = Router();
router.use(requireAuth);

router.get(
  '/providers/:service',
  asyncHandler(async (req: Request, res: Response) => {
    const providers = listActiveProviders(req.params.service);
    res.json({ service: req.params.service, providers });
  }),
);

export default router;
