import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { recordError } from './error.service';

/**
 * Public endpoint the web panel / apps POST their own client-side errors to.
 * No auth (errors happen before and after sign-in). Abuse is bounded: payloads
 * are size-capped here and the service dedupes by signature, so a flood of the
 * same error bumps one row's count instead of growing the table.
 */
const router = Router();

const errorSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  stack: z.string().max(8000).optional(),
  url: z.string().max(300).optional(),
  release: z.string().max(60).optional(),
});

router.post('/error', validate(errorSchema), asyncHandler(async (req: Request, res: Response) => {
  const b = req.body as z.infer<typeof errorSchema>;
  await recordError({
    source: 'web',
    message: b.message,
    stack: b.stack ?? null,
    route: b.url ?? null,
    release: b.release ?? null,
    userAgent: req.get('user-agent') ?? null,
  });
  res.status(202).json({ ok: true });
}));

export default router;
