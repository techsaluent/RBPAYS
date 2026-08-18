import { Request, Response, Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';

/**
 * Public website configuration — branding + admin-authored pages. No auth:
 * the landing site and panel read these to render the configured brand,
 * logo, colours, contact details and custom pages.
 */
const router = Router();

// Settings that must never be exposed on the public endpoint (they configure
// security policy, not branding). Everything else is safe to render publicly.
const PRIVATE_SETTING_KEYS = new Set(['security_admin_ip_allowlist']);

router.get(
  '/settings',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query<{ key: string; value: string | null }>('SELECT key, value FROM site_settings');
    const settings: Record<string, string> = {};
    for (const r of rows) {
      if (PRIVATE_SETTING_KEYS.has(r.key)) continue;
      settings[r.key] = r.value ?? '';
    }
    res.json({ settings });
  }),
);

router.get(
  '/pages',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query(
      'SELECT slug, title, sort_order FROM site_pages WHERE published = true ORDER BY sort_order, title',
    );
    res.json({ items: rows });
  }),
);

router.get(
  '/pages/:slug',
  asyncHandler(async (req: Request, res: Response) => {
    const { rows } = await query(
      'SELECT slug, title, content, updated_at FROM site_pages WHERE slug = $1 AND published = true',
      [req.params.slug],
    );
    if (!rows[0]) throw ApiError.notFound('Page not found');
    res.json({ page: rows[0] });
  }),
);

export default router;
