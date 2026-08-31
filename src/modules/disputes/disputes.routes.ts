import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';
import { emitEvent } from '../notify/events.service';
import { addMessage, disputeReceiptHtml } from './dispute.service';

const router = Router();
router.use(requireAuth);

const createSchema = z
  .object({
    reference: z.string().trim().max(64).optional(),
    transaction_id: z.string().uuid().optional(),
    category: z.enum(['not_credited', 'wrong_amount', 'double_charge', 'service_failed', 'other']),
    description: z.string().trim().min(5).max(1000),
    customer_ref: z.string().trim().max(120).optional(),
  })
  .refine((v) => v.reference || v.transaction_id, {
    message: 'Provide the transaction reference or id',
    path: ['reference'],
  });

function ticketNo(): string {
  return 'DSP-' + randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

/**
 * Resolution SLA (hours) for a dispute. Money-stuck categories get a tighter
 * deadline; everything else uses the admin-configurable default (dispute_sla_hours).
 */
async function slaHoursFor(category: string): Promise<number> {
  const { rows } = await query<{ value: string | null }>(
    "SELECT value FROM site_settings WHERE key = 'dispute_sla_hours'",
  );
  const base = Number(rows[0]?.value) || 24;
  const fast: Record<string, number> = { not_credited: 12, double_charge: 12, wrong_amount: 12 };
  return fast[category] ?? base;
}

// Raise a dispute on one of my transactions.
router.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof createSchema>;

    // Resolve + authorize the transaction (must belong to the raiser).
    const txn = await query<{ id: string; reference: string; user_id: string }>(
      `SELECT id, reference, user_id FROM transactions
        WHERE ($1::uuid IS NOT NULL AND id = $1) OR ($2::text IS NOT NULL AND reference = $2)
        LIMIT 1`,
      [b.transaction_id ?? null, b.reference ?? null],
    );
    const t = txn.rows[0];
    if (!t) throw ApiError.notFound('Transaction not found for that reference');
    if (t.user_id !== req.user.id) throw ApiError.forbidden('You can only dispute your own transactions');

    // One open dispute per transaction.
    const existing = await query(
      "SELECT 1 FROM disputes WHERE transaction_id = $1 AND status IN ('open','in_review') LIMIT 1",
      [t.id],
    );
    if (existing.rowCount) throw ApiError.conflict('An open dispute already exists for this transaction');

    const slaHours = await slaHoursFor(b.category);
    const { rows } = await query(
      `INSERT INTO disputes (ticket_no, reference, transaction_id, raised_by, category, description, customer_ref, sla_due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' hours')::interval) RETURNING *`,
      [ticketNo(), t.reference, t.id, req.user.id, b.category, b.description, b.customer_ref ?? null, String(slaHours)],
    );
    const dispute = rows[0];
    await addMessage(dispute.id, req.user.id, 'retailer', 'comment', b.description);
    emitEvent('dispute.raised', {
      ticket_no: dispute.ticket_no,
      reference: dispute.reference,
      category: dispute.category,
      raised_by: req.user.id,
    });
    res.status(201).json({ dispute });
  }),
);

// My disputes.
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rows } = await query(
      'SELECT * FROM disputes WHERE raised_by = $1 ORDER BY created_at DESC LIMIT 100',
      [req.user.id],
    );
    res.json({ items: rows });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rows } = await query('SELECT * FROM disputes WHERE id = $1 AND raised_by = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (!rows[0]) throw ApiError.notFound('Dispute not found');
    const msgs = await query(
      'SELECT * FROM dispute_messages WHERE dispute_id = $1 ORDER BY created_at',
      [req.params.id],
    );
    res.json({ dispute: rows[0], messages: msgs.rows });
  }),
);

// Member adds a reply to their dispute thread.
router.post(
  '/:id/messages',
  validate(z.object({ message: z.string().trim().min(1).max(1000) })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const own = await query('SELECT id FROM disputes WHERE id = $1 AND raised_by = $2', [req.params.id, req.user.id]);
    if (!own.rows[0]) throw ApiError.notFound('Dispute not found');
    const msg = await addMessage(req.params.id, req.user.id, 'retailer', 'comment', req.body.message);
    emitEvent('dispute.message', { dispute_id: req.params.id, by: 'member' });
    res.status(201).json({ message: msg });
  }),
);

// Printable dispute receipt (HTML).
router.get(
  '/:id/receipt',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rows } = await query('SELECT * FROM disputes WHERE id = $1 AND raised_by = $2', [req.params.id, req.user.id]);
    if (!rows[0]) throw ApiError.notFound('Dispute not found');
    const msgs = await query('SELECT * FROM dispute_messages WHERE dispute_id = $1 ORDER BY created_at', [req.params.id]);
    const brandRow = await query<{ value: string }>("SELECT value FROM site_settings WHERE key = 'brand_name'");
    res.type('html').send(disputeReceiptHtml(rows[0], msgs.rows, brandRow.rows[0]?.value || 'TutiPays'));
  }),
);

export default router;
