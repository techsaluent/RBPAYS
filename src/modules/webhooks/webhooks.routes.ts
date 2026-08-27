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
  if (['success', 'successful', 'true', '1', 'completed', 'complete', 'processed', 'paid', 'settled'].includes(v))
    return 'success';
  if (['failed', 'failure', 'fail', 'false', '0', 'rejected', 'reject', 'error', 'declined', 'reversed', 'refunded', 'bounced', 'cancelled', 'canceled'].includes(v))
    return 'failed';
  // 'accepted' / 'queued' / 'initiated' / 'processing' are interim -> pending
  return 'pending';
}

const pick = (o: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const k of keys) {
    const val = o[k];
    if (val !== undefined && val !== null && String(val) !== '') return String(val);
  }
  return undefined;
};

/** Timing-safe HMAC-SHA256 check of a raw body against a hex signature. */
function verifyHmac(raw: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const sig = signature.trim().replace(/^sha256=/i, ''); // some vendors prefix it
  return (
    expected.length === sig.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
  );
}

/**
 * Shared callback handler. Parses the many field/status variants aggregators
 * use, finds our original `reference`, and settles whichever service that
 * reference belongs to — so ONE callback works for every service (dmt, bbps,
 * recharge, payout, aeps, cms, upi, matm, aadhaar_pay, pan_card, travel,
 * insurance, card_swipe, …). `providerTag` labels the event source.
 */
async function handleCallback(
  req: Request,
  res: Response,
  providerTag: string,
): Promise<void> {
  const raw = rawText(req);
  const body = JSON.parse(raw) as Record<string, unknown>;
  // Accept the many names aggregators use for the client reference / status.
  const reference = pick(body, ['reference', 'client_ref', 'clientRef', 'client_reference', 'client_referenceId', 'client_reference_id', 'client_ref_id', 'reference_id', 'referenceId', 'refid', 'ref', 'orderid', 'order_id', 'clientReferenceNo']);
  const rawStatus = pick(body, ['status', 'txn_status', 'txnStatus', 'transaction_status', 'state', 'response_status']);
  if (!reference) throw ApiError.badRequest('Missing transaction reference in callback');

  // `service` is optional and only used to label the event — settlement finds
  // the real service from the reference itself.
  const service = pick(body, ['service', 'type', 'service_code']) ?? providerTag;
  const status = normalizeStatus(rawStatus);
  const providerRef = pick(body, ['provider_ref', 'providerRef', 'txnid', 'txn_id', 'transaction_id', 'transactionId', 'tid', 'opr_referenceId', 'operator_ref', 'operatorId', 'opid']);
  const utr = pick(body, ['utr', 'bank_ref', 'bankRef', 'bank_ref_num', 'rrn', 'bank_utr']);
  const message = pick(body, ['message', 'msg', 'remark', 'status_message', 'response_message', 'txstatus_desc', 'description']);

  const externalId = `${providerTag}:${reference}:${status}`;
  if (!(await recordEvent(providerTag, service, externalId, body))) {
    res.json({ status: 'duplicate' });
    return;
  }

  await settleByReference(reference, providerTag, { status, providerRef, utr, message });

  await markProcessed(providerTag, externalId);
  res.json({ status: 'ok', reference, settled: status });
}

router.post(
  '/aggregator',
  asyncHandler(async (req: Request, res: Response) => {
    const secret = await aggregatorWebhookSecret();
    if (!secret) throw ApiError.forbidden('Aggregator webhook secret not configured');
    if (!verifyHmac(rawText(req), String(req.headers['x-webhook-signature'] ?? ''), secret)) {
      throw ApiError.unauthorized('Invalid webhook signature');
    }
    await handleCallback(req, res, 'aggregator');
  }),
);

// ---------------------------------------------------------------------
// Per-provider callback: /webhooks/provider/:id
//   Each configured provider has its OWN callback URL and its own signing
//   secret (service_providers.webhook_secret), so multiple aggregators can
//   post callbacks and each is verified independently. Falls back to the
//   global aggregator secret when a provider has none set.
// ---------------------------------------------------------------------
router.post(
  '/provider/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { rows } = await query<{ label: string; service_code: string; webhook_secret: string | null }>(
      'SELECT label, service_code, webhook_secret FROM service_providers WHERE id = $1',
      [req.params.id],
    );
    const provider = rows[0];
    if (!provider) throw ApiError.notFound('Unknown callback endpoint');
    const secret = (provider.webhook_secret || (await aggregatorWebhookSecret())).trim();
    if (!secret) throw ApiError.forbidden('Provider webhook secret not configured');
    if (!verifyHmac(rawText(req), String(req.headers['x-webhook-signature'] ?? ''), secret)) {
      throw ApiError.unauthorized('Invalid webhook signature');
    }
    await handleCallback(req, res, `provider:${req.params.id}`);
  }),
);

export default router;
