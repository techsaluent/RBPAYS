import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query, withTransaction } from '../../../db';
import { rupeesToPaise } from '../../utils/money';
import { credit, debit } from '../wallet/wallet.service';
import { makeReference } from '../../utils/reference';

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  to: z.string().trim().min(3).max(120), // receiver phone or email
  amount: z.coerce.number().positive().max(200000),
  charge: z.coerce.number().min(0).default(0),
  note: z.string().trim().max(200).optional(),
  reference: z.string().trim().max(64).optional(),
});

// Wallet-to-wallet P2P: debit sender (amount + charge), credit receiver (amount),
// atomically. Internal — no external provider. Idempotent on reference.
router.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const senderId = req.user.id;
    const body = req.body as z.infer<typeof createSchema>;
    const amountPaise = rupeesToPaise(body.amount);
    const chargePaise = rupeesToPaise(body.charge);
    const reference = (req.header('Idempotency-Key') || body.reference || makeReference('W2W')).trim();

    // Idempotency: same reference returns the original transfer.
    const existing = await query('SELECT * FROM wallet_transfers WHERE reference = $1', [reference]);
    if (existing.rows[0]) {
      res.status(200).json({ transfer: existing.rows[0], idempotent: true });
      return;
    }

    // Resolve receiver by phone, email or username; block self-transfer.
    const recv = await query<{ id: string }>(
      'SELECT id FROM users WHERE phone = $1 OR lower(email) = lower($1) OR lower(username) = lower($1) LIMIT 1',
      [body.to],
    );
    const receiverId = recv.rows[0]?.id;
    if (!receiverId) throw ApiError.notFound('Receiver not found');
    if (receiverId === senderId) throw ApiError.badRequest('Cannot transfer to yourself');

    const transfer = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO wallet_transfers (sender_id, receiver_id, amount_paise, charge_paise, note, reference, status)
         VALUES ($1,$2,$3,$4,$5,$6,'success') RETURNING *`,
        [senderId, receiverId, amountPaise, chargePaise, body.note ?? null, reference],
      );
      const t = rows[0];

      await debit(client, {
        userId: senderId,
        amountPaise: amountPaise + chargePaise,
        source: 'wallet_transfer',
        referenceId: t.id,
        description: `Transfer to ${body.to} (${reference})`,
      });
      await credit(client, {
        userId: receiverId,
        amountPaise,
        source: 'wallet_transfer',
        referenceId: t.id,
        description: `Transfer received (${reference})`,
      });

      // Unified ledger rows for both parties.
      await client.query(
        `INSERT INTO transactions (user_id, service, direction, service_txn_id, reference, amount_paise, charge_paise, net_paise, status)
         VALUES ($1,'wallet_transfer','debit',$2,$3,$4,$5,$6,'success')`,
        [senderId, t.id, reference, amountPaise, chargePaise, amountPaise + chargePaise],
      );
      await client.query(
        `INSERT INTO transactions (user_id, service, direction, service_txn_id, reference, amount_paise, net_paise, status)
         VALUES ($1,'wallet_transfer','credit',$2,$3,$4,$4,'success')`,
        [receiverId, t.id, `${reference}-CR`, amountPaise],
      );
      return t;
    });

    res.status(201).json({ transfer, idempotent: false });
  }),
);

// Transfers I sent or received.
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rows } = await query(
      `SELECT * FROM wallet_transfers WHERE sender_id = $1 OR receiver_id = $1
        ORDER BY created_at DESC LIMIT 50`,
      [req.user.id],
    );
    res.json({ items: rows });
  }),
);

export default router;
