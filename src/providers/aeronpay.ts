import { httpJson, HttpError } from './http';
import { activeConfig, ActiveProvider } from './registry';
import {
  BbpsPayInput,
  BbpsProvider,
  DmtProvider,
  DmtTransferInput,
  PayoutInput,
  PayoutProvider,
  ProviderResult,
  RechargeInput,
  RechargeProvider,
} from './types';

/**
 * AeronPay adapter (https://developers.aeronpay.in).
 *
 * Auth: tokenless header-based — `client-id` + `client-secret`.
 *   Map the super-admin provider row like so:
 *     api_key    -> client-id
 *     api_secret -> client-secret
 *     base_url   -> optional override (defaults to production)
 *     extra      -> optional per-service path overrides + payout knobs
 *
 * Amounts are sent in rupees (string). Our reference travels as
 * `client_referenceId`, so the async status callback settles by reference.
 */
const DEFAULT_BASE = 'https://api.aeronpay.in/api/serviceapi-prod/api';

interface AeronData {
  transactionId?: string;
  opr_referenceId?: string;
  client_referenceId?: string;
  utr?: string;
  acknowledged?: string | number;
  error_message?: string;
  description?: string;
}
interface AeronResponse {
  status?: string;
  statusCode?: string | number;
  message?: string;
  data?: AeronData;
}

function cfgFor(service: string, providerId?: string): ActiveProvider | undefined {
  return activeConfig(service, providerId);
}

function baseUrl(c?: ActiveProvider): string {
  return (c?.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
}

function headers(c?: ActiveProvider): Record<string, string> {
  if (!c?.apiKey || !c?.apiSecret) throw new Error('AeronPay not configured (client-id / client-secret missing)');
  return { 'client-id': c.apiKey, 'client-secret': c.apiSecret };
}

/** SUCCESS -> success · PENDING/ACCEPTED/INITIATED -> pending · FAILED/REJECTED -> failed. */
function mapStatus(s: string | undefined): ProviderResult['status'] {
  const v = String(s ?? '').toUpperCase();
  if (v === 'SUCCESS' || v === 'COMPLETED') return 'success';
  if (['FAILED', 'FAILURE', 'REJECTED', 'DECLINED', 'ERROR'].includes(v)) return 'failed';
  return 'pending'; // PENDING | ACCEPTED | INITIATED | PROCESSING | unknown
}

function mapResponse(raw: AeronResponse): ProviderResult {
  const d = raw.data ?? {};
  return {
    status: mapStatus(raw.status),
    providerRef: d.transactionId ?? d.opr_referenceId ?? undefined,
    utr: d.utr || undefined,
    message: raw.message ?? d.description ?? d.error_message,
    raw,
  };
}

async function post(service: string, path: string, body: unknown, providerId?: string): Promise<ProviderResult> {
  const c = cfgFor(service, providerId);
  try {
    const raw = await httpJson<AeronResponse>(`${baseUrl(c)}${path}`, {
      method: 'POST',
      headers: headers(c),
      body,
    });
    return mapResponse(raw);
  } catch (err) {
    if (err instanceof HttpError) {
      const b = err.body as AeronResponse | undefined;
      // A structured 4xx still carries a status we can trust.
      if (b && (b.status || b.data)) return mapResponse(b);
      return { status: 'failed', message: `AeronPay HTTP ${err.status}`, raw: err.body };
    }
    // Network/timeout: unknown outcome -> pending, reconcile via callback/status.
    return { status: 'pending', message: (err as Error).message };
  }
}

const rupees = (paise: number): string => (paise / 100).toFixed(2);
const extraStr = (c: ActiveProvider | undefined, key: string, fallback: string): string =>
  (c?.extra && typeof c.extra[key] === 'string' ? (c.extra[key] as string) : fallback);

export const aeronpayRecharge: RechargeProvider = {
  name: 'aeronpay',
  recharge(input: RechargeInput): Promise<ProviderResult> {
    const c = cfgFor('recharge', input.providerId);
    const path = extraStr(c, 'recharge_path', '/utility/recharge/prepaidrecharge');
    return post('recharge', path, {
      amount: rupees(input.amountPaise),
      number: input.number,
      operatorCode: input.operator, // pass operator code (e.g. RJP, ATP)
      client_referenceId: input.reference,
      billermode: input.rechargeType === 'dth' ? 'dthrecharge' : 'prepaidrecharge',
    }, input.providerId);
  },
};

export const aeronpayBbps: BbpsProvider = {
  name: 'aeronpay',
  pay(input: BbpsPayInput): Promise<ProviderResult> {
    const c = cfgFor('bbps', input.providerId);
    const path = extraStr(c, 'bbps_path', '/utility/billpayment/initiatepayment');
    return post('bbps', path, {
      amount: rupees(input.amountPaise),
      biller_number: input.consumerNumber,
      operatorCode: input.billerId,
      client_referenceId: input.reference,
      billermode: 'billpayment',
    }, input.providerId);
  },
};

/**
 * Payout / bank transfer. AeronPay's payout body fields are provisioned per
 * merchant, so the path is overridable via `extra.payout_path`. Defaults follow
 * the documented client_referenceId / amount / beneficiary contract.
 */
function payoutBody(input: PayoutInput, c?: ActiveProvider): Record<string, unknown> {
  return {
    client_referenceId: input.reference,
    amount: rupees(input.amountPaise),
    bankProfileId: extraStr(c, 'bank_profile_id', ''),
    accountNumber: input.accountNumber,
    ifsc: input.ifsc,
    beneficiaryName: input.beneficiaryName,
    transferMode: input.mode, // IMPS | NEFT | RTGS | UPI
    remarks: 'TutiPays payout',
    latitude: extraStr(c, 'latitude', '0'),
    longitude: extraStr(c, 'longitude', '0'),
  };
}

export const aeronpayPayout: PayoutProvider = {
  name: 'aeronpay',
  payout(input: PayoutInput): Promise<ProviderResult> {
    const c = cfgFor('payout', input.providerId);
    const path = extraStr(c, 'payout_path', '/payout/transfer');
    return post('payout', path, payoutBody(input, c), input.providerId);
  },
};

export const aeronpayDmt: DmtProvider = {
  name: 'aeronpay',
  transfer(input: DmtTransferInput): Promise<ProviderResult> {
    const c = cfgFor('dmt', input.providerId);
    const path = extraStr(c, 'dmt_path', '/payout/transfer');
    return post('dmt', path, payoutBody({ ...input, mode: input.mode } as PayoutInput, c), input.providerId);
  },
};
