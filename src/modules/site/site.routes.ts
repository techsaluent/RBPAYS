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
const PRIVATE_SETTING_KEYS = new Set([
  'security_admin_ip_allowlist',
  'aggregator_webhook_secret',
  'automation_webhook_url',
  'security_otp_bypass_code',
]);

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
  '/services',
  asyncHandler(async (_req: Request, res: Response) => {
    // A card shows only when it is marked visible AND — if it is linked to an
    // operational service (code) — that service is not disabled. So pausing a
    // service in the admin Services desk also removes its marketing card.
    const { rows } = await query(
      `SELECT ss.icon, ss.title, ss.subtitle, ss.category
         FROM site_services ss
         LEFT JOIN services s ON s.code = ss.code
        WHERE ss.visible = true
          AND (ss.code IS NULL OR s.code IS NULL OR s.enabled = true)
        ORDER BY ss.sort_order, ss.id`,
    );
    res.json({ items: rows });
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
