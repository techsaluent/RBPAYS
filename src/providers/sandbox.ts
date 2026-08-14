import crypto from 'crypto';
import {
  AepsInput,
  AepsProvider,
  BbpsPayInput,
  BbpsProvider,
  CardSwipeInput,
  CardSwipeProvider,
  CmsPayInput,
  CmsProvider,
  CreateOrderInput,
  CreateOrderResult,
  DmtProvider,
  DmtTransferInput,
  GatewayProvider,
  GenericServiceInput,
  GenericServiceProvider,
  PayoutInput,
  PayoutProvider,
  ProviderResult,
  RechargeInput,
  RechargeProvider,
  VerifyPaymentInput,
} from './types';

/**
 * Sandbox providers. Fully functional for local/dev use with deterministic
 * outcomes driven by the amount, so tests can exercise every branch:
 *   - ₹13 exactly  -> failed  (triggers wallet reversal)
 *   - ₹7  exactly  -> pending (settled later via webhook/poll)
 *   - anything else -> success
 */
function outcome(amountPaise: number): ProviderResult['status'] {
  if (amountPaise === 1300) return 'failed';
  if (amountPaise === 700) return 'pending';
  return 'success';
}

function ref(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export const sandboxDmt: DmtProvider = {
  name: 'sandbox',
  async transfer(input: DmtTransferInput): Promise<ProviderResult> {
    const status = outcome(input.amountPaise);
    return {
      status,
      providerRef: ref('sbxdmt'),
      utr: status === 'success' ? ref('UTR').toUpperCase() : undefined,
      message: `sandbox DMT ${status}`,
    };
  },
};

export const sandboxPayout: PayoutProvider = {
  name: 'sandbox',
  async payout(input: PayoutInput): Promise<ProviderResult> {
    const status = outcome(input.amountPaise);
    return {
      status,
      providerRef: ref('sbxpo'),
      utr: status === 'success' ? ref('UTR').toUpperCase() : undefined,
      message: `sandbox payout ${status}`,
    };
  },
};

export const sandboxBbps: BbpsProvider = {
  name: 'sandbox',
  async pay(input: BbpsPayInput): Promise<ProviderResult> {
    const status = outcome(input.amountPaise);
    return { status, providerRef: ref('sbxbb'), message: `sandbox BBPS ${status}` };
  },
};

export const sandboxRecharge: RechargeProvider = {
  name: 'sandbox',
  async recharge(input: RechargeInput): Promise<ProviderResult> {
    const status = outcome(input.amountPaise);
    return { status, providerRef: ref('sbxrc'), message: `sandbox recharge ${status}` };
  },
};

export const sandboxAeps: AepsProvider = {
  name: 'sandbox',
  async execute(input: AepsInput): Promise<ProviderResult> {
    const status = outcome(input.amountPaise);
    return {
      status,
      providerRef: ref('sbxaeps'),
      rrn: status === 'success' ? ref('RRN').toUpperCase() : undefined,
      // Return a synthetic balance for balance-enquiry / mini-statement.
      balancePaise: input.txnType !== 'cash_withdrawal' ? 1523400 : undefined,
      message: `sandbox AEPS ${input.txnType} ${status}`,
    };
  },
};

export const sandboxCms: CmsProvider = {
  name: 'sandbox',
  async pay(input: CmsPayInput): Promise<ProviderResult> {
    const status = outcome(input.amountPaise);
    return { status, providerRef: ref('sbxcms'), message: `sandbox CMS ${status}` };
  },
};

export const sandboxCardSwipe: CardSwipeProvider = {
  name: 'sandbox',
  async swipe(input: CardSwipeInput): Promise<ProviderResult> {
    const status = outcome(input.amountPaise);
    return {
      status,
      providerRef: ref('sbxpos'),
      rrn: status === 'success' ? ref('RRN').toUpperCase() : undefined,
      message: `sandbox card swipe ${status}`,
    };
  },
};

// Services that return a retrieval reference number on success.
const RRN_SERVICES = new Set(['matm', 'aadhaar_pay']);

export const sandboxGeneric: GenericServiceProvider = {
  name: 'sandbox',
  async execute(service: string, input: GenericServiceInput): Promise<ProviderResult> {
    const status = outcome(input.amountPaise);
    return {
      status,
      providerRef: ref(`sbx${service}`),
      utr: service === 'upi' && status === 'success' ? ref('UTR').toUpperCase() : undefined,
      rrn: RRN_SERVICES.has(service) && status === 'success' ? ref('RRN').toUpperCase() : undefined,
      message: `sandbox ${service} ${status}`,
    };
  },
};

export const sandboxGateway: GatewayProvider = {
  name: 'sandbox',
  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    return {
      gatewayOrderId: ref('order'),
      checkout: { provider: 'sandbox', amount: input.amountPaise, currency: input.currency },
    };
  },
  // Sandbox accepts the deterministic signature sha256(orderId|paymentId).
  verifyPayment(input: VerifyPaymentInput): boolean {
    const expected = crypto
      .createHash('sha256')
      .update(`${input.gatewayOrderId}|${input.gatewayPaymentId}`)
      .digest('hex');
    return safeEqual(expected, input.signature);
  },
  verifyWebhook(rawBody: string, signature: string): boolean {
    const expected = crypto.createHash('sha256').update(rawBody).digest('hex');
    return safeEqual(expected, signature);
  },
};

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
