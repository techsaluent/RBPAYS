import crypto from 'crypto';
import { env } from '../config/env';
import { httpJson } from './http';
import {
  CreateOrderInput,
  CreateOrderResult,
  GatewayProvider,
  PayoutInput,
  PayoutProvider,
  ProviderResult,
  VerifyPaymentInput,
} from './types';

const API = 'https://api.razorpay.com/v1';

function authHeader(): string {
  const token = Buffer.from(
    `${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`,
  ).toString('base64');
  return `Basic ${token}`;
}

function assertConfigured(): void {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)');
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------
// Payment Gateway (Razorpay Standard Checkout)
// ---------------------------------------------------------------------
export const razorpayGateway: GatewayProvider = {
  name: 'razorpay',

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    assertConfigured();
    const order = await httpJson<{ id: string }>(`${API}/orders`, {
      method: 'POST',
      headers: { Authorization: authHeader() },
      body: {
        amount: input.amountPaise, // Razorpay uses paise
        currency: input.currency,
        receipt: input.reference,
        notes: { purpose: input.purpose },
      },
    });
    return {
      gatewayOrderId: order.id,
      checkout: {
        key: env.RAZORPAY_KEY_ID,
        order_id: order.id,
        amount: input.amountPaise,
        currency: input.currency,
      },
      raw: order,
    };
  },

  // razorpay_signature = HMAC_SHA256(order_id | payment_id, key_secret)
  verifyPayment(input: VerifyPaymentInput): boolean {
    assertConfigured();
    const expected = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`${input.gatewayOrderId}|${input.gatewayPaymentId}`)
      .digest('hex');
    return safeEqual(expected, input.signature);
  },

  // X-Razorpay-Signature = HMAC_SHA256(rawBody, webhook_secret)
  verifyWebhook(rawBody: string, signature: string): boolean {
    if (!env.RAZORPAY_WEBHOOK_SECRET) {
      throw new Error('RAZORPAY_WEBHOOK_SECRET not configured');
    }
    const expected = crypto
      .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
    return safeEqual(expected, signature);
  },
};

// ---------------------------------------------------------------------
// Payout (RazorpayX): contact -> fund_account -> payout
// ---------------------------------------------------------------------
function mapPayoutStatus(status: string): ProviderResult['status'] {
  switch (status) {
    case 'processed':
      return 'success';
    case 'reversed':
    case 'failed':
    case 'rejected':
    case 'cancelled':
      return 'failed';
    default: // queued, pending, processing, created
      return 'pending';
  }
}

export const razorpayPayout: PayoutProvider = {
  name: 'razorpay',

  async payout(input: PayoutInput): Promise<ProviderResult> {
    assertConfigured();
    if (!env.RAZORPAYX_ACCOUNT_NUMBER) {
      throw new Error('RAZORPAYX_ACCOUNT_NUMBER not configured');
    }
    const headers = { Authorization: authHeader() };

    // 1) Contact
    const contact = await httpJson<{ id: string }>(`${API}/contacts`, {
      method: 'POST',
      headers,
      body: { name: input.beneficiaryName, type: 'customer', reference_id: input.reference },
    });

    // 2) Fund account (bank_account)
    const fundAccount = await httpJson<{ id: string }>(`${API}/fund_accounts`, {
      method: 'POST',
      headers,
      body: {
        contact_id: contact.id,
        account_type: 'bank_account',
        bank_account: {
          name: input.beneficiaryName,
          ifsc: input.ifsc,
          account_number: input.accountNumber,
        },
      },
    });

    // 3) Payout (idempotent via X-Payout-Idempotency = our reference)
    const payout = await httpJson<{ id: string; status: string; utr?: string }>(
      `${API}/payouts`,
      {
        method: 'POST',
        headers: { ...headers, 'X-Payout-Idempotency': input.reference },
        body: {
          account_number: env.RAZORPAYX_ACCOUNT_NUMBER,
          fund_account_id: fundAccount.id,
          amount: input.amountPaise,
          currency: 'INR',
          mode: input.mode,
          purpose: 'payout',
          queue_if_low_balance: true,
          reference_id: input.reference,
        },
      },
    );

    return {
      status: mapPayoutStatus(payout.status),
      providerRef: payout.id,
      utr: payout.utr,
      message: `razorpayx payout ${payout.status}`,
      raw: payout,
    };
  },
};
