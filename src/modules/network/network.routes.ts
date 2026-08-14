import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { usernameSchema } from '../auth/auth.schemas';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { getWalletByUser } from '../wallet/wallet.service';
import { earningsFor } from '../commission/commission.service';
import {
  createMember,
  downlineCounts,
  downlineTree,
  listDownline,
} from '../members/members.service';

const router = Router();
router.use(requireAuth);

// Only distribution members have a panel/network.
function requireMember(req: Request): { id: string; role: string } {
  if (!req.user) throw ApiError.unauthorized();
  if (!['retailer', 'distributor', 'master_distributor'].includes(req.user.role)) {
    throw ApiError.forbidden('Only retailers, distributors and master distributors have a panel');
  }
  return req.user;
}

// Panel dashboard: wallet, downline counts, earnings summary.
router.get(
  '/panel',
  asyncHandler(async (req: Request, res: Response) => {
    const me = requireMember(req);
    const [wallet, counts, earnings] = await Promise.all([
      getWalletByUser(me.id),
      downlineCounts(me.id),
      earningsFor(me.id, 5),
    ]);
    res.json({
      role: me.role,
      wallet,
      downline_counts: counts,
      earnings: { total_paise: earnings.total_paise, count: earnings.count, recent: earnings.items },
    });
  }),
);

const createMemberSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  username: usernameSchema.optional(),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
  password: z.string().min(8).max(128),
  role: z.enum(['retailer', 'distributor', 'master_distributor']),
});

// Onboard a downline member below me (rank-checked in the service).
router.post(
  '/members',
  validate(createMemberSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const me = requireMember(req);
    const b = req.body as z.infer<typeof createMemberSchema>;
    const member = await createMember({ parentId: me.id, parentRole: me.role, ...b });
    res.status(201).json({ member });
  }),
);

const listSchema = z.object({
  role: z.enum(['retailer', 'distributor', 'master_distributor']).optional(),
});

// Direct downline (optionally filtered by role).
router.get(
  '/members',
  validate(listSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const me = requireMember(req);
    const q = req.query as unknown as z.infer<typeof listSchema>;
    res.json({ items: await listDownline(me.id, q.role) });
  }),
);

// Full downline tree.
router.get(
  '/downline',
  asyncHandler(async (req: Request, res: Response) => {
    const me = requireMember(req);
    res.json({ items: await downlineTree(me.id) });
  }),
);

const earningsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// My commission earnings.
router.get(
  '/earnings',
  validate(earningsSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const me = requireMember(req);
    const q = req.query as unknown as z.infer<typeof earningsSchema>;
    res.json(await earningsFor(me.id, q.limit, q.offset));
  }),
);

export default router;
