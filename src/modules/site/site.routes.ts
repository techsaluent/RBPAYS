import { Request, Response, Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';
import { brandingForHost, hiddenServiceCodesForHost } from '../tenant/tenant.service';

// The host to resolve a tenant from: explicit ?host= (behind a proxy) or the request Host header.
const reqHost = (req: Request): string => (typeof req.query.host === 'string' && req.query.host) || req.get('host') || '';

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
  'uidai_offline_cert',
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

// White-label Stage 2: resolve the brand for the requesting host so the
// login / landing page themes a partner's custom domain before sign-in.
// Host comes from an explicit ?host= (useful behind a proxy) or the request's
// own Host header. Unknown/unverified hosts return the platform brand.
router.get(
  '/branding',
  asyncHandler(async (req: Request, res: Response) => {
    const branding = await brandingForHost(reqHost(req));
    res.json({ branding });
  }),
);

router.get(
  '/services',
  asyncHandler(async (req: Request, res: Response) => {
    // A card shows only when it is marked visible AND — if it is linked to an
    // operational service (code) — that service is not disabled. So pausing a
    // service in the admin Services desk also removes its marketing card.
    const { rows } = await query<{ code: string | null }>(
      `SELECT ss.code, ss.icon, ss.title, ss.subtitle, ss.category, ss.terms
         FROM site_services ss
         LEFT JOIN services s ON s.code = ss.code
        WHERE ss.visible = true
          AND (ss.code IS NULL OR s.code IS NULL OR s.enabled = true)
        ORDER BY ss.sort_order, ss.id`,
    );
    // White-label Stage 3: on a tenant's custom domain, also drop cards the
    // tenant has hidden for their own brand.
    const hidden = new Set(await hiddenServiceCodesForHost(reqHost(req)));
    const items = hidden.size ? rows.filter((r) => !r.code || !hidden.has(r.code)) : rows;
    res.json({ items });
  }),
);

// Operational status of every catalog service (purely services.enabled, not
// affected by marketing visibility). The site uses it to hide any element
// tagged data-service="<code>" for a service that is currently disabled.
router.get(
  '/service-status',
  asyncHandler(async (req: Request, res: Response) => {
    const { rows } = await query<{ code: string; enabled: boolean }>('SELECT code, enabled FROM services');
    const disabled = new Set(rows.filter((r) => r.enabled === false).map((r) => r.code));
    // White-label Stage 3: a tenant's own hidden services count as disabled on
    // their branded site, so brand.js strips those data-service elements too.
    for (const c of await hiddenServiceCodesForHost(reqHost(req))) disabled.add(c);
    res.json({ disabled: [...disabled] });
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
