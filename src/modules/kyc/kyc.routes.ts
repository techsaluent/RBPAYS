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
import { verifyPan, aadhaarSendOtp, aadhaarVerifyOtp, verifyGstin } from './verify.service';
import { processOfflineKyc } from './aadhaar-offline.service';
import { reviewKycDocument, kycAiReviewEnabled } from './kyc-ai.service';
import { logger } from '../../config/logger';

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
    const document = rows[0];
    // AI-assist (opt-in): pre-compute a review recommendation for the admin,
    // best-effort and non-blocking. The AI never changes status.
    if (b.file_url && (await kycAiReviewEnabled())) {
      void reviewKycDocument(document.id as string).catch((err) =>
        logger.warn({ err: (err as Error).message, docId: document.id }, 'kyc ai review (on upload) failed'));
    }
    res.status(201).json({ document });
  }),
);

// ---- Digital KYC: instant PAN + Aadhaar-OTP verification (self-service) ----
/** Record a digitally-verified document and recompute the member's KYC. */
async function recordVerified(userId: string, docType: string, docNumber: string, remarks = 'Digitally verified'): Promise<string> {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO kyc_documents (user_id, doc_type, doc_number, status, remarks, reviewed_at)
       VALUES ($1,$2,$3,'verified',$4, now())`,
      [userId, docType, docNumber, remarks],
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

// Aadhaar Paperless Offline e-KYC: upload the UIDAI-signed XML + share phrase.
const offlineSchema = z.object({
  xml: z.string().min(50).max(900000),
  share_code: z.string().trim().max(32).optional(),
  mobile: z.string().trim().max(15).optional(),
});
router.post(
  '/verify/aadhaar-offline',
  validate(offlineSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof offlineSchema>;
    const result = await processOfflineKyc(b.xml, { share_code: b.share_code, mobile: b.mobile });
    if (!result.ok || !result.data) throw ApiError.unprocessable(result.message);
    const d = result.data;
    const masked = 'XXXXXXXX' + d.aadhaar_last4;
    if (result.signature_verified) {
      const status = await recordVerified(req.user.id, 'aadhaar', masked,
        `Offline e-KYC · ${d.name || ''}${d.dob ? ' · DOB ' + d.dob : ''}`.trim());
      if (status === 'verified') void notifyKyc(req.user.id, 'verified');
    } else {
      // Parsed but not cryptographically verified → queue for a human with the
      // extracted details; never auto-approved.
      await query(
        `INSERT INTO kyc_documents (user_id, doc_type, doc_number, status, remarks)
         VALUES ($1,'aadhaar',$2,'pending',$3)`,
        [req.user.id, masked, `Offline e-KYC (needs review) · ${d.name || ''}${d.dob ? ' · DOB ' + d.dob : ''} · ${result.signature_checked ? 'signature FAILED' : 'no UIDAI cert configured'}`],
      );
    }
    res.json({
      ok: result.ok,
      signature_checked: result.signature_checked,
      signature_verified: result.signature_verified,
      mobile_confirmed: result.mobile_confirmed,
      message: result.message,
      data: {
        name: d.name, dob: d.dob, gender: d.gender, care_of: d.care_of,
        address: d.address_text, aadhaar_last4: d.aadhaar_last4,
        reference_id: d.reference_id, photo_base64: d.photo_base64,
      },
    });
  }),
);

const gstinSchema = z.object({ gstin: z.string().trim().min(15).max(20) });
router.post(
  '/verify/gstin',
  validate(gstinSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof gstinSchema>;
    const result = await verifyGstin(b.gstin);
    // Record the GST document only when it is structurally genuine (checksum ok).
    // A live-verified "active" status is recorded with the legal name as remarks.
    if (result.valid && result.gstin) {
      const status = await recordVerified(req.user.id, 'gst', result.gstin);
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

// Run (or re-run) the AI recommendation for a document on demand (admin).
// Returns the recommendation; the human still confirms via /:id/review.
router.post(
  '/:id/ai-review',
  asyncHandler(requirePermission('kyc.review')),
  asyncHandler(async (req: Request, res: Response) => {
    const rec = await reviewKycDocument(req.params.id);
    if (!rec) {
      throw ApiError.unprocessable('AI review unavailable — set a vision-capable AI endpoint in API Hub, and ensure the document has an image.');
    }
    res.json({ recommendation: rec });
  }),
);

export default router;
