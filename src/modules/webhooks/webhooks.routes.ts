import { Request, Response, Router } from 'express';
import crypto from 'crypto';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { query, withTransaction } from '../../../db';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { credit } from '../wallet/wallet.service';
import { settleByReference } from '../_shared/settle';
import { getGatewayProvider } from '../../providers';
import { ProviderResult } from '../../providers/types';

const router = Router();

/** Body arrives as a Buffer (see raw mount in app.ts). Returns the text. */
function rawText(req: Request): string {
  return Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body ?? {});
}

/**
 * Record a provider event; returns true if it is new (should be processed),
 * false if we've already seen it (idempotent replay).
 */
async function recordEvent(
  provider: string,
  eventType: string | undefined,
  externalId: string,
  payload: unknown,
): Promise<boolean> {
  const { rowCount } = await query(
    `INSERT INTO provider_events (provider, event_type, external_id, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, external_id) DO NOTHING`,
    [provider, eventType ?? null, externalId, JSON.stringify(payload)],
  );
  return rowCount === 1;
}

async function markProcessed(provider: string, externalId: string): Promise<void> {
  await query(
    'UPDATE provider_events SET processed = true WHERE provider = $1 AND external_id = $2',
    [provider, externalId],
  );
}

/** Credit a wallet-topup order captured via webhook (idempotent by order status). */
async function creditTopupByGatewayOrderId(gatewayOrderId: string, paymentId: string): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM pg_orders WHERE gateway_order_id = $1 FOR UPDATE',
      [gatewayOrderId],
    );
    const order = rows[0];
    if (!order || order.status !== 'pending') return; // unknown or already settled
    await client.query(
      `UPDATE pg_orders SET status = 'success', gateway_payment_id = $1, status_message = 'captured via webhook' WHERE id = $2`,
      [paymentId, order.id],
    );
    if (order.purpose === 'wallet_topup') {
      await credit(client, {
        userId: order.user_id,
        amountPaise: Number(order.amount_paise),
        source: 'payment_gateway',
        referenceId: order.id,
        description: `Wallet top-up via ${order.gateway} webhook (${order.reference})`,
      });
    }
    await client.query(
      `INSERT INTO transactions
         (user_id, service, direction, service_txn_id, reference, amount_paise, net_paise, status, provider, status_message)
       VALUES ($1,'payment_gateway','credit',$2,$3,$4,$4,'success',$5,'captured via webhook')
       ON CONFLICT (reference) DO NOTHING`,
      [order.user_id, order.id, order.reference, Number(order.amount_paise), order.gateway],
    );
  });
}

// ---------------------------------------------------------------------
// Razorpay webhook: X-Razorpay-Signature = HMAC_SHA256(rawBody, secret)
// ---------------------------------------------------------------------
router.post(
  '/razorpay',
  asyncHandler(async (req: Request, res: Response) => {
    const raw = rawText(req);
    const signature = String(req.headers['x-razorpay-signature'] ?? '');
    if (!getGatewayProvider().verifyWebhook(raw, signature)) {
      throw ApiError.unauthorized('Invalid webhook signature');
    }
    const event = JSON.parse(raw) as {
      event: string;
      payload: Record<string, { entity: Record<string, unknown> }>;
    };

    // Idempotency key: prefer the event id, fall back to a body hash.
    const externalId =
      String(req.headers['x-razorpay-event-id'] ?? '') ||
      crypto.createHash('sha256').update(raw).digest('hex');
    if (!(await recordEvent('razorpay', event.event, externalId, event))) {
      res.json({ status: 'duplicate' });
      return;
    }

    switch (event.event) {
      case 'payment.captured':
      case 'order.paid': {
        const payment = event.payload.payment?.entity as { id: string; order_id: string };
        if (payment?.order_id) {
          await creditTopupByGatewayOrderId(payment.order_id, payment.id);
        }
        break;
      }
      case 'payout.processed':
      case 'payout.failed':
      case 'payout.reversed':
      case 'payout.pending':
      case 'payout.queued':
      case 'payout.initiated':
      case 'payout.processing': {
        const payout = event.payload.payout?.entity as {
          id: string;
          reference_id: string;
          status: string;
          utr?: string;
        };
        // processed -> success; failed/reversed -> failed; queued/pending/
        // initiated/processing -> pending (interim, no wallet effect yet).
        const status: ProviderResult['status'] =
          payout.status === 'processed'
            ? 'success'
            : ['failed', 'reversed', 'rejected', 'cancelled'].includes(String(payout.status))
              ? 'failed'
              : 'pending';
        if (payout?.reference_id) {
          await settleByReference(payout.reference_id, 'razorpay', {
            status,
            providerRef: payout.id,
            utr: payout.utr,
            message: `payout ${payout.status}`,
          });
        }
        break;
      }
      default:
        logger.info({ event: event.event }, 'razorpay webhook ignored');
    }

    await markProcessed('razorpay', externalId);
    res.json({ status: 'ok' });
  }),
);

// ---------------------------------------------------------------------
// Aggregator webhook: X-Webhook-Signature = HMAC_SHA256(rawBody, secret)
// Tolerant of common field-name and status-string variants so most Indian
// aggregators work with little/no per-vendor code. It only needs to find our
// original `reference` and a status that maps to success | failed | pending.
// ---------------------------------------------------------------------
/** Resolve the shared secret: admin-set site setting wins, else env. */
async function aggregatorWebhookSecret(): Promise<string> {
  const { rows } = await query<{ value: string | null }>(
    "SELECT value FROM site_settings WHERE key = 'aggregator_webhook_secret'",
  );
  return (rows[0]?.value || env.AGGREGATOR_WEBHOOK_SECRET || '').trim();
}

/** Map any provider status string to our three canonical states. */
function normalizeStatus(raw: unknown): ProviderResult['status'] {
  const v = String(raw ?? '').toLowerCase().trim();
  if (['success', 'successful', 'true', '1', 'completed', 'complete', 'processed', 'paid', 'settled', 'accepted'].includes(v))
    return 'success';
  if (['failed', 'failure', 'fail', 'false', '0', 'rejected', 'reject', 'error', 'declined', 'reversed', 'refunded', 'bounced', 'cancelled', 'canceled'].includes(v))
    return 'failed';
  return 'pending'; // pending | processing | initiated | queued | inprocess | 2 | unknown
}

const pick = (o: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const k of keys) {
    const val = o[k];
    if (val !== undefined && val !== null && String(val) !== '') return String(val);
  }
  return undefined;
};

router.post(
  '/aggregator',
  asyncHandler(async (req: Request, res: Response) => {
    const raw = rawText(req);
    const signature = String(req.headers['x-webhook-signature'] ?? '');
    const secret = await aggregatorWebhookSecret();
    if (!secret) throw ApiError.forbidden('Aggregator webhook secret not configured');
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const ok =
      expected.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    if (!ok) throw ApiError.unauthorized('Invalid webhook signature');

    const body = JSON.parse(raw) as Record<string, unknown>;
    // Accept the many names aggregators use for the client reference / status.
    const reference = pick(body, ['reference', 'client_ref', 'clientRef', 'client_reference', 'reference_id', 'referenceId', 'refid', 'ref', 'orderid', 'order_id', 'clientReferenceNo']);
    const rawStatus = pick(body, ['status', 'txn_status', 'txnStatus', 'transaction_status', 'state', 'response_status']);
    if (!reference) throw ApiError.badRequest('Missing transaction reference in callback');

    const service = pick(body, ['service', 'type', 'service_code']) ?? 'aggregator';
    const status = normalizeStatus(rawStatus);
    const providerRef = pick(body, ['provider_ref', 'providerRef', 'txnid', 'txn_id', 'transaction_id', 'operator_ref', 'operatorId', 'opid']);
    const utr = pick(body, ['utr', 'bank_ref', 'bankRef', 'rrn', 'bank_utr']);
    const message = pick(body, ['message', 'msg', 'remark', 'status_message', 'response_message']);

    const externalId = `${service}:${reference}:${status}`;
    if (!(await recordEvent('aggregator', service, externalId, body))) {
      res.json({ status: 'duplicate' });
      return;
    }

    await settleByReference(reference, 'aggregator', { status, providerRef, utr, message });

    await markProcessed('aggregator', externalId);
    res.json({ status: 'ok' });
  }),
);

export default router;
