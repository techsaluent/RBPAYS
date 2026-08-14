import { env } from '../config/env';
import { httpJson, HttpError } from './http';
import {
  AepsInput,
  AepsProvider,
  BbpsPayInput,
  BbpsProvider,
  CardSwipeInput,
  CardSwipeProvider,
  CmsPayInput,
  CmsProvider,
  DmtProvider,
  DmtTransferInput,
  ProviderResult,
  RechargeInput,
  RechargeProvider,
} from './types';

/**
 * Generic adapter for an Indian recharge/DMT/BBPS aggregator switch
 * (Paysprint / EKO / RechargeAPI style). Configure with:
 *   AGGREGATOR_BASE_URL, AGGREGATOR_AUTH_TOKEN, AGGREGATOR_API_KEY, AGGREGATOR_PARTNER_ID
 *
 * Response shapes vary per vendor, so mapping is intentionally tolerant:
 * it looks for the common `status`, reference and message fields. Adjust
 * `mapResponse` / endpoint paths to match your specific aggregator's docs.
 */
function assertConfigured(): void {
  if (!env.AGGREGATOR_BASE_URL || !env.AGGREGATOR_AUTH_TOKEN) {
    throw new Error('Aggregator not configured (AGGREGATOR_BASE_URL / AGGREGATOR_AUTH_TOKEN)');
  }
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.AGGREGATOR_AUTH_TOKEN}`,
    'X-Api-Key': env.AGGREGATOR_API_KEY,
    'X-Partner-Id': env.AGGREGATOR_PARTNER_ID,
  };
}

interface RawResponse {
  status?: string | number | boolean;
  response_code?: string | number;
  txn_status?: string;
  txnid?: string;
  refid?: string;
  reference_id?: string;
  operator_ref?: string;
  utr?: string;
  rrn?: string;
  balance?: number;
  message?: string;
  msg?: string;
}

function normStatus(raw: RawResponse): ProviderResult['status'] {
  const s = String(raw.txn_status ?? raw.status ?? raw.response_code ?? '').toLowerCase();
  if (['success', 'true', '1', 'completed', 'processed'].includes(s)) return 'success';
  if (['failed', 'false', '0', 'failure', 'error', 'rejected'].includes(s)) return 'failed';
  return 'pending';
}

function mapResponse(raw: RawResponse): ProviderResult {
  return {
    status: normStatus(raw),
    providerRef:
      raw.txnid ?? raw.refid ?? raw.reference_id ?? raw.operator_ref ?? undefined,
    utr: raw.utr,
    rrn: raw.rrn,
    balancePaise: raw.balance == null ? undefined : Math.round(raw.balance * 100),
    message: raw.message ?? raw.msg,
    raw,
  };
}

async function post(path: string, body: unknown): Promise<ProviderResult> {
  assertConfigured();
  try {
    const raw = await httpJson<RawResponse>(`${env.AGGREGATOR_BASE_URL}${path}`, {
      method: 'POST',
      headers: headers(),
      body,
    });
    return mapResponse(raw);
  } catch (err) {
    // A 4xx/5xx from the switch is a definite failure -> caller reverses wallet.
    if (err instanceof HttpError) {
      return { status: 'failed', message: `aggregator HTTP ${err.status}`, raw: err.body };
    }
    // Network/timeout: leave pending, reconcile via webhook/poll.
    return { status: 'pending', message: (err as Error).message };
  }
}

export const aggregatorDmt: DmtProvider = {
  name: 'aggregator',
  transfer(input: DmtTransferInput): Promise<ProviderResult> {
    return post('/dmt/transfer', {
      reference: input.reference,
      amount: input.amountPaise / 100,
      beneficiary_name: input.beneficiaryName,
      account_number: input.accountNumber,
      ifsc: input.ifsc,
      mode: input.mode,
    });
  },
};

export const aggregatorBbps: BbpsProvider = {
  name: 'aggregator',
  pay(input: BbpsPayInput): Promise<ProviderResult> {
    return post('/bbps/paybill', {
      reference: input.reference,
      amount: input.amountPaise / 100,
      biller_id: input.billerId,
      consumer_number: input.consumerNumber,
      category: input.category,
    });
  },
};

export const aggregatorRecharge: RechargeProvider = {
  name: 'aggregator',
  recharge(input: RechargeInput): Promise<ProviderResult> {
    return post('/recharge', {
      reference: input.reference,
      amount: input.amountPaise / 100,
      operator: input.operator,
      number: input.number,
      type: input.rechargeType,
      circle: input.circle,
    });
  },
};

export const aggregatorAeps: AepsProvider = {
  name: 'aggregator',
  execute(input: AepsInput): Promise<ProviderResult> {
    return post('/aeps', {
      reference: input.reference,
      txn_type: input.txnType,
      amount: input.amountPaise / 100,
      aadhaar: input.aadhaarRef,
      iin: input.bankIin,
      mobile: input.mobile,
    });
  },
};

export const aggregatorCms: CmsProvider = {
  name: 'aggregator',
  pay(input: CmsPayInput): Promise<ProviderResult> {
    return post('/cms/pay', {
      reference: input.reference,
      amount: input.amountPaise / 100,
      agent_id: input.agentId,
      account_number: input.accountNumber,
      customer_name: input.customerName,
    });
  },
};

export const aggregatorCardSwipe: CardSwipeProvider = {
  name: 'aggregator',
  swipe(input: CardSwipeInput): Promise<ProviderResult> {
    return post('/card-swipe', {
      reference: input.reference,
      amount: input.amountPaise / 100,
      card_network: input.cardNetwork,
      card_type: input.cardType,
      tid: input.tid,
    });
  },
};
