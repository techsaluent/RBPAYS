import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { logAudit } from '../audit/audit.service';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query, withTransaction } from '../../../db';
import { notifyKyc } from '../notify/alerts';
import { verifyPan, aadhaarSendOtp, aadhaarVerifyOtp } from './verify.service';

const router = Router();
router.use(requireAuth);

const submitSchema = z.object({
  doc_type: z.enum(['aadhaar', 'pan', 'gst', 'shop_photo', 'bank_proof', 'selfie', 'other']),
  doc_number: z.string().trim().max(64).optional(),
  file_url: z.string().trim().url().max(1024).optional(),
});

// Submit a KYC document.
router.post(
  '/',
  validate(submitSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof submitSchema>;
    const { rows } = await query(
      `INSERT INTO kyc_documents (user_id, doc_type, doc_number, file_url)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.id, b.doc_type, b.doc_number ?? null, b.file_url ?? null],
    );
    res.status(201).json({ document: rows[0] });
  }),
);

// ---- Digital KYC: instant PAN + Aadhaar-OTP verification (self-service) ----
/** Record a digitally-verified document and recompute the member's KYC. */
async function recordVerified(userId: string, docType: string, docNumber: string): Promise<string> {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO kyc_documents (user_id, doc_type, doc_number, status, remarks, reviewed_at)
       VALUES ($1,$2,$3,'verified','Digitally verified', now())`,
      [userId, docType, docNumber],
    );
    return recomputeUserKyc(client, userId);
  });
}

const panSchema = z.object({ pan: z.string().trim().min(10).max(10), name: z.string().trim().max(120).optional() });
router.post(
  '/verify/pan',
  validate(panSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof panSchema>;
    const result = await verifyPan(b.pan, b.name);
    if (result.verified) {
      const status = await recordVerified(req.user.id, 'pan', b.pan.toUpperCase());
      if (status === 'verified') void notifyKyc(req.user.id, 'verified');
    }
    res.json(result);
  }),
);

const aadhaarSchema = z.object({ aadhaar: z.string().trim().regex(/^\d{12}$/, 'Aadhaar must be 12 digits') });
router.post(
  '/verify/aadhaar/send-otp',
  validate(aadhaarSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof aadhaarSchema>;
    const r = await aadhaarSendOtp(b.aadhaar);
    res.json(r);
  }),
);

const otpSchema = z.object({
  aadhaar: z.string().trim().regex(/^\d{12}$/),
  ref: z.string().trim().max(120),
  otp: z.string().trim().min(4).max(8),
});
router.post(
  '/verify/aadhaar/verify-otp',
  validate(otpSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof otpSchema>;
    const result = await aadhaarVerifyOtp(b.aadhaar, b.ref, b.otp);
    if (result.verified) {
      const status = await recordVerified(req.user.id, 'aadhaar', b.aadhaar.slice(0, 4) + 'XXXX' + b.aadhaar.slice(-4));
      if (status === 'verified') void notifyKyc(req.user.id, 'verified');
    }
    res.json(result);
  }),
);

// List my KYC documents + my overall KYC status.
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const docs = await query('SELECT * FROM kyc_documents WHERE user_id = $1 ORDER BY created_at DESC', [
      req.user.id,
    ]);
    const status = await query<{ kyc_status: string }>('SELECT kyc_status FROM users WHERE id = $1', [
      req.user.id,
    ]);
    res.json({ kyc_status: status.rows[0]?.kyc_status, documents: docs.rows });
  }),
);

// ---- Admin review -----------------------------------------------------
const reviewSchema = z.object({
  status: z.enum(['verified', 'rejected']),
  remarks: z.string().trim().max(500).optional(),
});

// List all pending KYC documents (admin).
router.get(
  '/pending',
  asyncHandler(requirePermission('kyc.review')),
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query(
      `SELECT k.*, u.full_name, u.phone, u.role
         FROM kyc_documents k JOIN users u ON u.id = k.user_id
        WHERE k.status = 'pending'
        ORDER BY k.created_at ASC`,
    );
    res.json({ items: rows });
  }),
);

/** Recompute a user's overall KYC status from their documents. */
async function recomputeUserKyc(client: import('pg').PoolClient, userId: string): Promise<string> {
  const { rows } = await client.query<{ status: string; n: string }>(
    'SELECT status, COUNT(*) AS n FROM kyc_documents WHERE user_id = $1 GROUP BY status',
    [userId],
  );
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  const next = byStatus.rejected ? 'rejected' : byStatus.verified ? 'verified' : 'pending';
  await client.query('UPDATE users SET kyc_status = $1 WHERE id = $2', [next, userId]);
  return next;
}

// Approve / reject a KYC document (admin).
router.post(
  '/:id/review',
  asyncHandler(requirePermission('kyc.review')),
  validate(reviewSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof reviewSchema>;
    const reviewerId = req.user.id;

    let outcome = '';
    const document = await withTransaction(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM kyc_documents WHERE id = $1 FOR UPDATE',
        [req.params.id],
      );
      const doc = rows[0];
      if (!doc) throw ApiError.notFound('KYC document not found');

      const { rows: updated } = await client.query(
        `UPDATE kyc_documents
            SET status = $1, remarks = $2, reviewed_by = $3, reviewed_at = now()
          WHERE id = $4 RETURNING *`,
        [b.status, b.remarks ?? null, reviewerId, doc.id],
      );
      outcome = await recomputeUserKyc(client, doc.user_id);
      return updated[0];
    });

    // Notify the member when their overall KYC becomes verified / rejected.
    if (outcome === 'verified' || outcome === 'rejected') void notifyKyc(document.user_id as string, outcome);

    await logAudit({ actorId: reviewerId, actorRole: req.user.role, action: 'kyc.review',
      targetType: 'kyc', targetId: document.id, detail: { status: b.status, remarks: b.remarks ?? null, user_id: document.user_id } });
    res.json({ document });
  }),
);

export default router;
