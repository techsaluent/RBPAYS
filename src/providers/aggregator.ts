import { env } from '../config/env';
import { httpJson, HttpError } from './http';
import { activeConfig } from './registry';
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
  GenericServiceInput,
  GenericServiceProvider,
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
interface AggConfig {
  baseUrl: string;
  authToken: string;
  apiKey: string;
  partnerId: string;
}

/**
 * Resolve aggregator credentials for a service: prefer the super-admin's
 * active provider row (from the registry), fall back to env. This is what
 * makes going live "just add API keys" — either paste them in the admin
 * panel or set AGGREGATOR_* env vars.
 */
function configFor(service?: string, providerId?: string): AggConfig {
  const a = service ? activeConfig(service, providerId) : undefined;
  return {
    baseUrl: a?.baseUrl || env.AGGREGATOR_BASE_URL,
    authToken: a?.authToken || env.AGGREGATOR_AUTH_TOKEN,
    apiKey: a?.apiKey || env.AGGREGATOR_API_KEY,
    partnerId: a?.partnerId || env.AGGREGATOR_PARTNER_ID,
  };
}

function assertConfigured(c: AggConfig): void {
  if (!c.baseUrl || !c.authToken) {
    throw new Error('Aggregator not configured (base URL / auth token missing)');
  }
}

function headers(c: AggConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${c.authToken}`,
    'X-Api-Key': c.apiKey,
    'X-Partner-Id': c.partnerId,
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

async function post(service: string, path: string, body: unknown, providerId?: string): Promise<ProviderResult> {
  const c = configFor(service, providerId);
  assertConfigured(c);
  try {
    const raw = await httpJson<RawResponse>(`${c.baseUrl}${path}`, {
      method: 'POST',
      headers: headers(c),
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
    return post('dmt', '/dmt/transfer', {
      reference: input.reference,
      amount: input.amountPaise / 100,
      beneficiary_name: input.beneficiaryName,
      account_number: input.accountNumber,
      ifsc: input.ifsc,
      mode: input.mode,
    }, input.providerId);
  },
};

export const aggregatorBbps: BbpsProvider = {
  name: 'aggregator',
  pay(input: BbpsPayInput): Promise<ProviderResult> {
    return post('bbps', '/bbps/paybill', {
      reference: input.reference,
      amount: input.amountPaise / 100,
      biller_id: input.billerId,
      consumer_number: input.consumerNumber,
      category: input.category,
    }, input.providerId);
  },
};

export const aggregatorRecharge: RechargeProvider = {
  name: 'aggregator',
  recharge(input: RechargeInput): Promise<ProviderResult> {
    return post('recharge', '/recharge', {
      reference: input.reference,
      amount: input.amountPaise / 100,
      operator: input.operator,
      number: input.number,
      type: input.rechargeType,
      circle: input.circle,
    }, input.providerId);
  },
};

export const aggregatorAeps: AepsProvider = {
  name: 'aggregator',
  execute(input: AepsInput): Promise<ProviderResult> {
    return post('aeps', '/aeps', {
      reference: input.reference,
      txn_type: input.txnType,
      amount: input.amountPaise / 100,
      aadhaar: input.aadhaarNumber ?? input.aadhaarRef,
      iin: input.bankIin,
      mobile: input.mobile,
      // Biometric authentication block (RD-service PID) for the switch.
      biometric_type: input.biometricType,
      pid_data: input.pidData,
    }, input.providerId);
  },
};

export const aggregatorCms: CmsProvider = {
  name: 'aggregator',
  pay(input: CmsPayInput): Promise<ProviderResult> {
    return post('cms', '/cms/pay', {
      reference: input.reference,
      amount: input.amountPaise / 100,
      agent_id: input.agentId,
      account_number: input.accountNumber,
      customer_name: input.customerName,
    }, input.providerId);
  },
};

export const aggregatorCardSwipe: CardSwipeProvider = {
  name: 'aggregator',
  swipe(input: CardSwipeInput): Promise<ProviderResult> {
    return post('card_swipe', '/card-swipe', {
      reference: input.reference,
      amount: input.amountPaise / 100,
      card_network: input.cardNetwork,
      card_type: input.cardType,
      tid: input.tid,
    }, input.providerId);
  },
};

export const aggregatorGeneric: GenericServiceProvider = {
  name: 'aggregator',
  execute(service: string, input: GenericServiceInput): Promise<ProviderResult> {
    return post(service, `/${service.replace(/_/g, '-')}`, {
      reference: input.reference,
      amount: input.amountPaise / 100,
      ...(input.meta ?? {}),
    }, input.providerId);
  },
};
