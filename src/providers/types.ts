/**
 * Provider abstraction. Each external switch (DMT/BBPS/recharge/payout) and
 * the payment gateway implements one of these interfaces. Amounts are always
 * integer paise. Providers must be pure I/O — no DB access, no wallet logic.
 */

export type ProviderStatus = 'success' | 'failed' | 'pending';

export interface ProviderResult {
  status: ProviderStatus;
  /** Provider's own reference / transaction id. */
  providerRef?: string;
  /** Bank UTR for DMT/payout when available. */
  utr?: string;
  /** Human-readable status detail. */
  message?: string;
  /** Raw provider response for auditing/debugging. */
  raw?: unknown;
}

export interface DmtTransferInput {
  reference: string;
  amountPaise: number;
  beneficiaryName: string;
  accountNumber: string;
  ifsc: string;
  mode: 'IMPS' | 'NEFT' | 'RTGS';
}

export interface PayoutInput {
  reference: string;
  amountPaise: number;
  beneficiaryName: string;
  accountNumber: string;
  ifsc: string;
  mode: 'IMPS' | 'NEFT' | 'RTGS' | 'UPI';
}

export interface BbpsPayInput {
  reference: string;
  amountPaise: number;
  billerId: string;
  consumerNumber: string;
  category?: string;
}

export interface RechargeInput {
  reference: string;
  amountPaise: number;
  operator: string;
  number: string;
  rechargeType: 'prepaid' | 'postpaid' | 'dth';
  circle?: string;
}

export interface CreateOrderInput {
  reference: string;
  amountPaise: number;
  currency: string;
  purpose: string;
}

export interface CreateOrderResult {
  gatewayOrderId: string;
  /** Extra fields the client checkout needs (key id, etc.). */
  checkout?: Record<string, unknown>;
  raw?: unknown;
}

export interface VerifyPaymentInput {
  gatewayOrderId: string;
  gatewayPaymentId: string;
  signature: string;
}

export interface DmtProvider {
  readonly name: string;
  transfer(input: DmtTransferInput): Promise<ProviderResult>;
}

export interface PayoutProvider {
  readonly name: string;
  payout(input: PayoutInput): Promise<ProviderResult>;
}

export interface BbpsProvider {
  readonly name: string;
  pay(input: BbpsPayInput): Promise<ProviderResult>;
}

export interface RechargeProvider {
  readonly name: string;
  recharge(input: RechargeInput): Promise<ProviderResult>;
}

export interface GatewayProvider {
  readonly name: string;
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  /** Returns true if the client-side payment signature is authentic. */
  verifyPayment(input: VerifyPaymentInput): boolean;
  /** Returns true if a webhook body/signature pair is authentic. */
  verifyWebhook(rawBody: string, signature: string): boolean;
}
