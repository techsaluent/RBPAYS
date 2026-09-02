import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';

/** Member's in-app notification inbox. */
const router = Router();
router.use(requireAuth);

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
  unread: z.coerce.boolean().optional(),
});

// List my notifications (newest first), optionally unread-only.
router.get(
  '/',
  validate(pageSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const q = req.query as unknown as { limit: number; offset: number; unread?: boolean };
    const { rows } = await query(
      `SELECT id, type, title, body, read_at, created_at
         FROM notifications
        WHERE user_id = $1 AND ($4::boolean IS NOT TRUE OR read_at IS NULL)
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [req.user.id, q.limit, q.offset, q.unread ?? null],
    );
    res.json({ items: rows, limit: q.limit, offset: q.offset });
  }),
);

// Unread badge count.
router.get(
  '/unread-count',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rows } = await query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [req.user.id],
    );
    res.json({ count: Number(rows[0]?.n ?? 0) });
  }),
);

// Mark one as read.
router.post(
  '/:id/read',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    await query('UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL', [
      req.params.id, req.user.id,
    ]);
    res.json({ ok: true });
  }),
);

// Mark all read.
router.post(
  '/read-all',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rowCount } = await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [
      req.user.id,
    ]);
    res.json({ ok: true, marked: rowCount ?? 0 });
  }),
);

export default router;
