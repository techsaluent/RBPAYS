import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { logAudit } from '../audit/audit.service';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query, withTransaction } from '../../../db';

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
async function recomputeUserKyc(client: import('pg').PoolClient, userId: string): Promise<void> {
  const { rows } = await client.query<{ status: string; n: string }>(
    'SELECT status, COUNT(*) AS n FROM kyc_documents WHERE user_id = $1 GROUP BY status',
    [userId],
  );
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  const next = byStatus.rejected ? 'rejected' : byStatus.verified ? 'verified' : 'pending';
  await client.query('UPDATE users SET kyc_status = $1 WHERE id = $2', [next, userId]);
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
      await recomputeUserKyc(client, doc.user_id);
      return updated[0];
    });

    await logAudit({ actorId: reviewerId, actorRole: req.user.role, action: 'kyc.review',
      targetType: 'kyc', targetId: document.id, detail: { status: b.status, remarks: b.remarks ?? null, user_id: document.user_id } });
    res.json({ document });
  }),
);

export default router;
