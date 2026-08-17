import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';
import { bigintToNumber, paiseToRupees } from '../../utils/money';

/** Member-facing tax profile + my TDS statement. */
const router = Router();
router.use(requireAuth);

router.get(
  '/profile',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rows } = await query('SELECT * FROM tax_profiles WHERE user_id = $1', [req.user.id]);
    res.json({ profile: rows[0] ?? null });
  }),
);

const profileSchema = z.object({
  pan: z.string().trim().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN').optional(),
  pan_name: z.string().trim().max(120).optional(),
  gstin: z.string().trim().max(20).optional(),
  state_code: z.string().trim().max(2).optional(),
});

// A member submits their PAN / GSTIN. pan_valid stays false until verified
// (by NSDL integration or admin) so the higher 20% TDS applies until then.
router.put(
  '/profile',
  validate(profileSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof profileSchema>;
    const { rows } = await query(
      `INSERT INTO tax_profiles (user_id, pan, pan_name, gstin, state_code)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET
         pan = COALESCE(EXCLUDED.pan, tax_profiles.pan),
         pan_name = COALESCE(EXCLUDED.pan_name, tax_profiles.pan_name),
         gstin = COALESCE(EXCLUDED.gstin, tax_profiles.gstin),
         state_code = COALESCE(EXCLUDED.state_code, tax_profiles.state_code)
       RETURNING *`,
      [req.user.id, b.pan ?? null, b.pan_name ?? null, b.gstin ?? null, b.state_code ?? null],
    );
    res.json({ profile: rows[0] });
  }),
);

// My TDS statement (194H commission + 194N cash) — Form 26Q source rows.
router.get(
  '/tds',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const totals = await query<{ gross: string; tds: string }>(
      `SELECT COALESCE(SUM(gross_paise),0) gross, COALESCE(SUM(tds_paise),0) tds
         FROM tds_records WHERE user_id = $1`,
      [req.user.id],
    );
    const { rows } = await query(
      `SELECT service_code, section, gross_paise, rate_bps, tds_paise, net_paise, created_at
         FROM tds_records WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user.id],
    );
    res.json({
      total_gross_paise: bigintToNumber(totals.rows[0].gross),
      total_tds_paise: bigintToNumber(totals.rows[0].tds),
      total_tds: paiseToRupees(totals.rows[0].tds),
      items: rows.map((r) => ({
        ...r,
        gross_paise: bigintToNumber(r.gross_paise as string),
        tds_paise: bigintToNumber(r.tds_paise as string),
        net_paise: bigintToNumber(r.net_paise as string),
      })),
    });
  }),
);

export default router;
