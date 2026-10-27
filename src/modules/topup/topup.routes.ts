import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query, withTransaction } from '../../../db';
import { rupeesToPaise, bigintToNumber, paiseToRupees } from '../../utils/money';
import { debit, credit } from '../wallet/wallet.service';
import { logAudit } from '../audit/audit.service';

// Where uploaded receipts land. Served read-only at /uploads (see app.ts).
export const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads');
const RECEIPT_DIR = path.join(UPLOAD_ROOT, 'receipts');
const RECEIPT_TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf',
};
const MAX_RECEIPT_BYTES = 3 * 1024 * 1024; // 3 MB

/**
 * Wallet top-up (self-service) for every network role. A member deposits
 * money into one of the company bank accounts (cash / bank transfer / UPI)
 * and submits the reference here; admin verifies and credits the wallet.
 */
const router = Router();
router.use(requireAuth);

// Company bank accounts a member can deposit into (active ones only).
router.get(
  '/bank-accounts',
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query(
      `SELECT id, label, bank_name, account_name, account_number, ifsc, branch, upi_id, instructions
         FROM company_bank_accounts
        WHERE is_active = true
        ORDER BY sort_order, created_at`,
    );
    res.json({ items: rows });
  }),
);

const createSchema = z.object({
  amount: z.coerce.number().positive().max(1_000_000),
  method: z.enum(['cash_deposit', 'bank_transfer', 'upi', 'gateway', 'other']),
  bank_account_id: z.string().uuid().optional(),
  reference: z.string().trim().max(80).optional(),
  proof_url: z.string().trim().url().max(500).optional(),
  note: z.string().trim().max(300).optional(),
});

// Submit a top-up request.
router.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof createSchema>;

    if (b.bank_account_id) {
      const acc = await query('SELECT 1 FROM company_bank_accounts WHERE id = $1 AND is_active = true', [
        b.bank_account_id,
      ]);
      if (!acc.rowCount) throw ApiError.badRequest('Invalid or inactive bank account');
    }

    const { rows } = await query(
      `INSERT INTO wallet_topup_requests
         (user_id, amount_paise, method, bank_account_id, reference, proof_url, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, amount_paise, method, bank_account_id, reference, status, created_at`,
      [
        req.user.id,
        rupeesToPaise(b.amount),
        b.method,
        b.bank_account_id ?? null,
        b.reference ?? null,
        b.proof_url ?? null,
        b.note ?? null,
      ],
    );
    const r = rows[0] as { amount_paise: string };
    res.status(201).json({
      request: { ...rows[0], amount_paise: bigintToNumber(r.amount_paise), amount: paiseToRupees(r.amount_paise) },
    });
  }),
);

const listSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// My top-up requests.
router.get(
  '/',
  validate(listSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const q = req.query as unknown as z.infer<typeof listSchema>;
    const { rows } = await query(
      `SELECT id, amount_paise, method, bank_account_id, reference, proof_url, note,
              status, remarks, reviewed_at, created_at
         FROM wallet_topup_requests
        WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4`,
      [req.user.id, q.status ?? null, q.limit, q.offset],
    );
    res.json({
      items: rows.map((r) => ({
        ...r,
        amount_paise: bigintToNumber(r.amount_paise as string),
        amount: paiseToRupees(r.amount_paise as string),
      })),
      limit: q.limit,
      offset: q.offset,
    });
  }),
);

// Upload a receipt image/PDF (base64) → stored on disk, returns its URL to use
// as proof_url on a top-up request. Bounded type + size.
router.post(
  '/proof',
  validate(z.object({
    content_base64: z.string().min(1).max(5_000_000),
    content_type: z.string().trim(),
    filename: z.string().trim().max(120).optional(),
  })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as { content_base64: string; content_type: string };
    const ext = RECEIPT_TYPES[b.content_type.toLowerCase()];
    if (!ext) throw ApiError.badRequest('Receipt must be a PNG, JPEG, WebP or PDF');
    const data = Buffer.from(b.content_base64.replace(/^data:[^,]+,/, ''), 'base64');
    if (data.length === 0) throw ApiError.badRequest('Empty file');
    if (data.length > MAX_RECEIPT_BYTES) throw ApiError.badRequest('Receipt is larger than 3 MB');
    await fs.mkdir(RECEIPT_DIR, { recursive: true });
    const name = `${req.user.id}-${randomUUID()}.${ext}`;
    await fs.writeFile(path.join(RECEIPT_DIR, name), data);
    res.status(201).json({ url: `/uploads/receipts/${name}` });
  }),
);

// Requests from my DIRECT downline that I (their upline) can approve.
router.get(
  '/incoming',
  validate(z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }), 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const q = req.query as unknown as { status: string };
    const { rows } = await query(
      `SELECT t.id, t.user_id, u.full_name AS member_name, u.phone AS member_phone,
              t.amount_paise, t.method, t.reference, t.proof_url, t.note, t.status, t.created_at
         FROM wallet_topup_requests t JOIN users u ON u.id = t.user_id
        WHERE u.parent_id = $1 AND t.status = $2
        ORDER BY t.created_at DESC LIMIT 100`,
      [req.user.id, q.status],
    );
    res.json({ items: rows.map((r) => ({ ...r, amount_paise: bigintToNumber(r.amount_paise as string), amount: paiseToRupees(r.amount_paise as string) })) });
  }),
);

// Upline approves a direct-downline member's top-up: float transfer from the
// upline's wallet to the member's. Only the member's immediate parent may do it.
router.post(
  '/incoming/:id/approve',
  validate(z.object({ remarks: z.string().trim().max(200).optional() })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const approverId = req.user.id;
    const remarks = (req.body as { remarks?: string }).remarks ?? null;

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{ user_id: string; amount_paise: string; status: string; parent_id: string | null }>(
        `SELECT t.user_id, t.amount_paise, t.status, u.parent_id
           FROM wallet_topup_requests t JOIN users u ON u.id = t.user_id
          WHERE t.id = $1 FOR UPDATE OF t`,
        [req.params.id],
      );
      const r = rows[0];
      if (!r) throw ApiError.notFound('Request not found');
      if (r.parent_id !== approverId) throw ApiError.forbidden('Only the member\'s upline can approve this request');
      if (r.status !== 'pending') throw ApiError.badRequest(`Request is already ${r.status}`);
      const amt = Number(r.amount_paise);

      // Move float: debit the upline (fails 422 if insufficient), credit the member.
      await debit(client, { userId: approverId, amountPaise: amt, source: 'float_transfer', referenceId: req.params.id, description: `Top-up approved for downline member` });
      const newBal = await credit(client, { userId: r.user_id, amountPaise: amt, source: 'topup', referenceId: req.params.id, description: `Top-up approved by upline` });

      await client.query(
        `UPDATE wallet_topup_requests
            SET status='approved', approval_mode='upline', reviewed_by=$2, reviewed_at=now(), remarks=$3
          WHERE id=$1`,
        [req.params.id, approverId, remarks],
      );
      return { memberId: r.user_id, amountPaise: amt, memberNewBalance: newBal };
    });

    await logAudit({ actorId: approverId, actorRole: req.user.role, action: 'topup.upline.approve',
      targetType: 'wallet_topup_request', targetId: req.params.id, detail: { member: result.memberId, amount_paise: result.amountPaise } });
    res.json({ ok: true, approved: true, amount: paiseToRupees(String(result.amountPaise)) });
  }),
);

// Upline rejects a direct-downline member's top-up (no money moves).
router.post(
  '/incoming/:id/reject',
  validate(z.object({ remarks: z.string().trim().min(1).max(200) })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rows } = await query<{ parent_id: string | null; status: string }>(
      `SELECT u.parent_id, t.status FROM wallet_topup_requests t JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
      [req.params.id],
    );
    const r = rows[0];
    if (!r) throw ApiError.notFound('Request not found');
    if (r.parent_id !== req.user.id) throw ApiError.forbidden('Only the member\'s upline can reject this request');
    if (r.status !== 'pending') throw ApiError.badRequest(`Request is already ${r.status}`);
    await query(
      `UPDATE wallet_topup_requests SET status='rejected', approval_mode='upline', reviewed_by=$2, reviewed_at=now(), remarks=$3 WHERE id=$1`,
      [req.params.id, req.user.id, (req.body as { remarks: string }).remarks],
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'topup.upline.reject',
      targetType: 'wallet_topup_request', targetId: req.params.id, detail: {} });
    res.json({ ok: true, rejected: true });
  }),
);

export default router;
