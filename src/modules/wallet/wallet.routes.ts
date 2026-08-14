import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { getWalletByUser, listLedger } from './wallet.service';

const router = Router();
router.use(requireAuth);

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    res.json({ wallet: await getWalletByUser(req.user.id) });
  }),
);

router.get(
  '/ledger',
  validate(pageSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { limit, offset } = req.query as unknown as { limit: number; offset: number };
    const items = await listLedger(req.user.id, limit, offset);
    res.json({ items, limit, offset });
  }),
);

export default router;
