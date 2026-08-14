import { Request, Response, Router } from 'express';
import crypto from 'crypto';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { query, withTransaction } from '../../../db';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { credit } from '../wallet/wallet.service';
import { settleServiceByReference, ServiceTable } from '../_shared/settle';
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
      case 'payout.reversed': {
        const payout = event.payload.payout?.entity as {
          id: string;
          reference_id: string;
          status: string;
          utr?: string;
        };
        const status: ProviderResult['status'] =
          payout.status === 'processed' ? 'success' : 'failed';
        if (payout?.reference_id) {
          await settleServiceByReference({
            table: 'payout_transactions',
            reference: payout.reference_id,
            providerName: 'razorpay',
            result: { status, providerRef: payout.id, utr: payout.utr, message: `payout ${payout.status}` },
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
// Body: { reference, service, status, provider_ref?, utr?, message? }
// ---------------------------------------------------------------------
const SERVICE_TABLES: Record<string, ServiceTable> = {
  dmt: 'dmt_transactions',
  bbps: 'bbps_transactions',
  recharge: 'recharge_transactions',
  payout: 'payout_transactions',
};

router.post(
  '/aggregator',
  asyncHandler(async (req: Request, res: Response) => {
    const raw = rawText(req);
    const signature = String(req.headers['x-webhook-signature'] ?? '');
    if (!env.AGGREGATOR_WEBHOOK_SECRET) {
      throw ApiError.forbidden('Aggregator webhook secret not configured');
    }
    const expected = crypto
      .createHmac('sha256', env.AGGREGATOR_WEBHOOK_SECRET)
      .update(raw)
      .digest('hex');
    const ok =
      expected.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    if (!ok) throw ApiError.unauthorized('Invalid webhook signature');

    const body = JSON.parse(raw) as {
      reference: string;
      service: string;
      status: string;
      provider_ref?: string;
      utr?: string;
      message?: string;
    };
    const table = SERVICE_TABLES[body.service];
    if (!table) throw ApiError.badRequest(`Unknown service: ${body.service}`);

    const externalId = `${body.service}:${body.reference}:${body.status}`;
    if (!(await recordEvent('aggregator', body.service, externalId, body))) {
      res.json({ status: 'duplicate' });
      return;
    }

    const status: ProviderResult['status'] =
      body.status === 'success' ? 'success' : body.status === 'failed' ? 'failed' : 'pending';

    await settleServiceByReference({
      table,
      reference: body.reference,
      providerName: 'aggregator',
      result: { status, providerRef: body.provider_ref, utr: body.utr, message: body.message },
    });

    await markProcessed('aggregator', externalId);
    res.json({ status: 'ok' });
  }),
);

export default router;
