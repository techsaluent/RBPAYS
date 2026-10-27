import { Request, Response, Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';
import { resolveBranding } from '../tenant/tenant.service';

/**
 * Branded member documents — ID card, certificate, letterhead — rendered as
 * printable HTML carrying the member's white-label brand (name, logo, colour,
 * support). The platform stays the engine underneath.
 */
const router = Router();
router.use(requireAuth);

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

interface Brand { brand_name: string; logo_url?: string | null; logo_emoji?: string | null; primary_color?: string | null; support_email?: string | null; phone?: string | null; company_name?: string | null; tagline?: string | null }

function brandColor(b: Brand): string {
  const hex = (b.primary_color || '').trim();
  return /^#?[0-9a-fA-F]{6}$/.test(hex) ? (hex.startsWith('#') ? hex : '#' + hex) : '#7C3AED';
}
function logoMark(b: Brand, size = 44): string {
  return b.logo_url
    ? `<img src="${esc(b.logo_url)}" alt="" style="width:${size}px;height:${size}px;border-radius:12px;object-fit:cover">`
    : `<span style="font-size:${Math.round(size * 0.6)}px">${esc(b.logo_emoji || '₹')}</span>`;
}
function page(title: string, color: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{--brand:${color}}
  *{box-sizing:border-box} body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#eef1f7;margin:0;padding:24px;color:#1b2340}
  .wrap{max-width:720px;margin:0 auto}
  .act{display:flex;gap:8px;justify-content:center;margin:14px 0}
  .btn{border:none;border-radius:10px;padding:9px 16px;font-size:14px;cursor:pointer;background:var(--brand);color:#fff}
  .btn.ghost{background:#fff;color:#1b2340;border:1px solid #d9deec}
  @media print{body{background:#fff;padding:0}.noprint{display:none}}
</style></head><body><div class="wrap">
  <div class="act noprint"><button class="btn" onclick="print()">🖨️ Print / Save PDF</button><button class="btn ghost" onclick="window.close()">Close</button></div>
  ${body}
</div></body></html>`;
}

async function member(userId: string) {
  const { rows } = await query<{ id: string; full_name: string; username: string | null; phone: string; email: string; role: string; kyc_status: string; created_at: string }>(
    'SELECT id, full_name, username, phone, email, role, kyc_status, created_at FROM users WHERE id = $1',
    [userId],
  );
  if (!rows[0]) throw ApiError.notFound('Member not found');
  return rows[0];
}
const roleLabel: Record<string, string> = {
  retailer: 'Authorised Retailer', distributor: 'Distributor', master_distributor: 'Master Distributor',
  admin: 'Administrator', staff: 'Staff', user: 'Customer',
};

// Branded ID card.
router.get(
  '/id-card',
  asyncHandler(async (req: Request, res: Response) => {
    const u = await member(req.user!.id);
    const b = (await resolveBranding(req.user!.id)) as unknown as Brand;
    const color = brandColor(b);
    const code = (u.username || u.id.slice(0, 8)).toUpperCase();
    const card = `
      <div style="max-width:420px;margin:0 auto;border-radius:18px;overflow:hidden;box-shadow:0 14px 40px rgba(30,34,90,.16);background:#fff">
        <div style="background:linear-gradient(135deg,${color},${color}cc);color:#fff;padding:18px 20px;display:flex;align-items:center;gap:12px">
          ${logoMark(b, 44)}<div><div style="font-weight:800;font-size:18px">${esc(b.brand_name)}</div>
          <div style="opacity:.9;font-size:12px">${esc(b.tagline || 'Digital services partner')}</div></div></div>
        <div style="padding:20px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div><div style="font-size:12px;color:#8a93b0;text-transform:uppercase;letter-spacing:.06em">${esc(roleLabel[u.role] || u.role)}</div>
              <div style="font-size:22px;font-weight:800;margin-top:2px">${esc(u.full_name)}</div></div>
            <div style="text-align:right"><div style="font-size:11px;color:#8a93b0">MEMBER ID</div><div style="font-weight:700;font-family:ui-monospace,monospace">${esc(code)}</div></div>
          </div>
          <table style="width:100%;margin-top:14px;font-size:13px;border-collapse:collapse">
            <tr><td style="color:#8a93b0;padding:4px 0">Mobile</td><td style="text-align:right;font-weight:600">${esc(u.phone)}</td></tr>
            <tr><td style="color:#8a93b0;padding:4px 0">KYC</td><td style="text-align:right;font-weight:600">${esc(u.kyc_status)}</td></tr>
            <tr><td style="color:#8a93b0;padding:4px 0">Member since</td><td style="text-align:right;font-weight:600">${new Date(u.created_at).toLocaleDateString('en-IN')}</td></tr>
          </table>
          <div style="margin-top:16px;border-top:1px dashed #e3e7f2;padding-top:10px;font-size:11px;color:#8a93b0">
            Support: ${esc(b.support_email || '')} ${b.phone ? '· ' + esc(b.phone) : ''}<br>Issued by ${esc(b.company_name || b.brand_name)}. This card certifies an authorised network member.</div>
        </div>
      </div>`;
    res.type('html').send(page(`ID Card — ${u.full_name}`, color, card));
  }),
);

// Branded authorisation certificate.
router.get(
  '/certificate',
  asyncHandler(async (req: Request, res: Response) => {
    const u = await member(req.user!.id);
    const b = (await resolveBranding(req.user!.id)) as unknown as Brand;
    const color = brandColor(b);
    const cert = `
      <div style="background:#fff;border:10px solid ${color};border-radius:8px;padding:48px 40px;text-align:center;box-shadow:0 14px 40px rgba(30,34,90,.12)">
        <div style="display:flex;justify-content:center;align-items:center;gap:12px;margin-bottom:8px">${logoMark(b, 52)}<span style="font-size:26px;font-weight:800;color:${color}">${esc(b.brand_name)}</span></div>
        <div style="letter-spacing:.3em;color:#8a93b0;font-size:12px;text-transform:uppercase;margin-top:10px">Certificate of Authorisation</div>
        <div style="margin:22px 0 6px;color:#5b6686">This certifies that</div>
        <div style="font-size:30px;font-weight:800;margin:6px 0">${esc(u.full_name)}</div>
        <div style="color:#5b6686;max-width:520px;margin:10px auto 0;line-height:1.6">is an <b>${esc(roleLabel[u.role] || u.role)}</b> of <b>${esc(b.company_name || b.brand_name)}</b>, authorised to offer its digital financial &amp; utility services through the ${esc(b.brand_name)} platform.</div>
        <div style="display:flex;justify-content:space-between;margin-top:44px;font-size:12px;color:#8a93b0">
          <div>Member ID<br><b style="color:#1b2340;font-family:ui-monospace,monospace">${esc((u.username || u.id.slice(0, 8)).toUpperCase())}</b></div>
          <div>Issued<br><b style="color:#1b2340">${new Date().toLocaleDateString('en-IN')}</b></div>
          <div style="text-align:right">Authorised signatory<br><b style="color:#1b2340">${esc(b.company_name || b.brand_name)}</b></div>
        </div>
      </div>`;
    res.type('html').send(page(`Certificate — ${u.full_name}`, color, cert));
  }),
);

// Branded blank letterhead (for official letters / notices).
router.get(
  '/letterhead',
  asyncHandler(async (req: Request, res: Response) => {
    const b = (await resolveBranding(req.user!.id)) as unknown as Brand;
    const color = brandColor(b);
    const lh = `
      <div style="background:#fff;min-height:900px;padding:0;box-shadow:0 14px 40px rgba(30,34,90,.10);border-radius:6px;overflow:hidden">
        <div style="background:${color};color:#fff;padding:22px 36px;display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:12px">${logoMark(b, 46)}<div><div style="font-size:22px;font-weight:800">${esc(b.brand_name)}</div><div style="opacity:.9;font-size:12px">${esc(b.tagline || '')}</div></div></div>
          <div style="text-align:right;font-size:12px;opacity:.95">${esc(b.support_email || '')}<br>${esc(b.phone || '')}</div>
        </div>
        <div style="padding:40px 36px;color:#334;min-height:640px;line-height:1.8">
          <p style="color:#8a93b0">Date: ${new Date().toLocaleDateString('en-IN')}</p>
          <p contenteditable="true" style="outline:none;color:#8a93b0">[ Type your letter here — click to edit, then Print / Save PDF. ]</p>
        </div>
        <div style="border-top:3px solid ${color};padding:14px 36px;font-size:11px;color:#8a93b0;text-align:center">${esc(b.company_name || b.brand_name)} · ${esc(b.support_email || '')} ${b.phone ? '· ' + esc(b.phone) : ''}</div>
      </div>`;
    res.type('html').send(page('Letterhead', color, lh));
  }),
);

export default router;
