import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';
import { bigintToNumber, paiseToRupees } from '../../utils/money';
import { toCsv, statementHtml } from '../reports/reports.service';

/** Member-facing tax profile + my TDS statement. */
const router = Router();
router.use(requireAuth);

/** Indian financial year window for a start year (e.g. 2026 → 1 Apr 2026 … 31 Mar 2027). */
function fyRange(startYear: number): { from: string; to: string; label: string } {
  return {
    from: `${startYear}-04-01T00:00:00.000Z`,
    to: `${startYear + 1}-04-01T00:00:00.000Z`,
    label: `FY ${startYear}-${String(startYear + 1).slice(-2)}`,
  };
}
/** The financial year that a date falls in (start year). */
function currentFyStartYear(d = new Date()): number {
  return d.getUTCMonth() + 1 >= 4 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

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

// Downloadable TDS certificate / statement for one financial year (HTML or CSV).
// This is the document a member hands to their accountant — 194H commission
// TDS + 194N cash TDS, itemised, with the member's PAN on the header.
const tdsStatementSchema = z.object({
  fy: z.coerce.number().int().min(2000).max(2100).optional(),
  format: z.enum(['html', 'csv']).default('html'),
});
router.get(
  '/tds/statement',
  validate(tdsStatementSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const q = req.query as unknown as z.infer<typeof tdsStatementSchema>;
    const fy = fyRange(q.fy ?? currentFyStartYear());

    const [prof, brand, data] = await Promise.all([
      query<{ pan: string | null; pan_name: string | null }>('SELECT pan, pan_name FROM tax_profiles WHERE user_id = $1', [req.user.id]),
      query<{ value: string }>("SELECT value FROM site_settings WHERE key = 'brand_name'"),
      query<{ service_code: string | null; section: string; gross_paise: string; rate_bps: number; tds_paise: string; net_paise: string; created_at: string }>(
        `SELECT service_code, section, gross_paise, rate_bps, tds_paise, net_paise, created_at
           FROM tds_records
          WHERE user_id = $1 AND created_at >= $2 AND created_at < $3
          ORDER BY created_at`,
        [req.user.id, fy.from, fy.to],
      ),
    ]);
    const rows = data.rows;
    const brandName = brand.rows[0]?.value || 'TutiPays';
    const pan = prof.rows[0]?.pan || '—';
    const name = prof.rows[0]?.pan_name || '';
    const sum = (k: 'gross_paise' | 'tds_paise') => rows.reduce((a, r) => a + Number(r[k]), 0);
    const r = (p: number) => paiseToRupees(String(p));

    if (q.format === 'csv') {
      const csv = toCsv(
        ['Date', 'Section', 'Service', 'Gross', 'Rate %', 'TDS', 'Net'],
        rows.map((x) => [
          new Date(x.created_at).toISOString().slice(0, 10), x.section, x.service_code || '',
          r(Number(x.gross_paise)), (x.rate_bps / 100).toFixed(2), r(Number(x.tds_paise)), r(Number(x.net_paise)),
        ]),
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="tds_${fy.label.replace(/\s/g, '_')}.csv"`);
      res.send(csv);
      return;
    }
    res.type('html').send(
      statementHtml({
        brand: brandName,
        title: 'TDS statement',
        subtitle: fy.label,
        meta: [
          ['PAN', pan],
          ...(name ? [['Name', name] as [string, string]] : []),
          ['Deductions', String(rows.length)],
          ['Total TDS', '₹' + r(sum('tds_paise'))],
        ],
        columns: [
          { label: 'Date' }, { label: 'Section' }, { label: 'Service' },
          { label: 'Gross', align: 'right' }, { label: 'Rate', align: 'right' },
          { label: 'TDS', align: 'right' }, { label: 'Net', align: 'right' },
        ],
        rows: rows.map((x) => [
          new Date(x.created_at).toLocaleDateString('en-IN'), x.section, String(x.service_code || '').replace(/_/g, ' '),
          '₹' + r(Number(x.gross_paise)), (x.rate_bps / 100).toFixed(2) + '%',
          '₹' + r(Number(x.tds_paise)), '₹' + r(Number(x.net_paise)),
        ]),
        totals: ['Total', '', '', '₹' + r(sum('gross_paise')), '', '₹' + r(sum('tds_paise')), ''],
      }),
    );
  }),
);

export default router;
