import crypto from 'crypto';
import { httpJson, HttpError } from './http';
import { activeConfig, ActiveProvider } from './registry';
import {
  AepsInput,
  AepsProvider,
  BbpsPayInput,
  BbpsProvider,
  DmtProvider,
  DmtTransferInput,
  GenericServiceInput,
  GenericServiceProvider,
  ProviderResult,
  RechargeInput,
  RechargeProvider,
} from './types';

/**
 * Eko (eps.eko.in) adapter.
 *
 * Auth per Eko's spec — three headers per request:
 *   developer_key         : static key issued after KYC   (provider api_key)
 *   secret-key            : base64(HMAC_SHA256(timestamp, base64(access_key)))
 *   secret-key-timestamp  : Unix epoch millis used in the HMAC
 * where access_key is the merchant's Eko secret (provider api_secret).
 *
 * Map the super-admin provider row:
 *   api_key    -> developer_key
 *   api_secret -> access_key (used to sign each request)
 *   partner_id -> initiator_id
 *   base_url   -> optional (defaults to production)
 *   extra      -> { user_code, dmt_path, aeps_path, bbps_path, recharge_path }
 *
 * Our reference travels as `client_ref_id`, so the async callback settles it.
 */
const DEFAULT_BASE = 'https://api.eko.in/ekoicici/v3';

/** secret-key = base64( HMAC_SHA256( timestamp, base64(access_key) ) ). */
function signHeaders(c: ActiveProvider): Record<string, string> {
  if (!c.apiKey || !c.apiSecret) throw new Error('Eko not configured (developer_key / access_key missing)');
  const timestamp = Date.now().toString();
  const encodedKey = Buffer.from(c.apiSecret).toString('base64');
  const secretKey = crypto.createHmac('sha256', encodedKey).update(timestamp).digest('base64');
  return {
    developer_key: c.apiKey,
    'secret-key': secretKey,
    'secret-key-timestamp': timestamp,
  };
}

interface EkoResponse {
  status?: number | string;
  message?: string;
  response_status_id?: number;
  data?: {
    tx_status?: string | number;
    tid?: string;
    txstatus_desc?: string;
    utr?: string;
    bank_ref_num?: string;
    rrn?: string;
    balance?: string | number;
    [k: string]: unknown;
  };
}

/**
 * Eko returns top-level status 0 when the request is accepted; the money
 * outcome is in data.tx_status (0 success · 1 failed/refunded · else pending).
 */
function mapResponse(raw: EkoResponse): ProviderResult {
  const d = raw.data ?? {};
  const top = String(raw.status ?? '');
  const tx = String(d.tx_status ?? '').toLowerCase();
  const desc = String(d.txstatus_desc ?? raw.message ?? '').toLowerCase();

  let status: ProviderResult['status'] = 'pending';
  if (top !== '0' && top !== '') {
    status = 'failed'; // request rejected
  } else if (tx === '0' || desc.includes('success')) {
    status = 'success';
  } else if (tx === '1' || desc.includes('fail') || desc.includes('refund') || desc.includes('reject')) {
    status = 'failed';
  }

  const balance = d.balance != null ? Math.round(Number(d.balance) * 100) : undefined;
  return {
    status,
    providerRef: d.tid || undefined,
    utr: d.utr || d.bank_ref_num || undefined,
    rrn: d.rrn || undefined,
    balancePaise: Number.isFinite(balance as number) ? balance : undefined,
    message: d.txstatus_desc || raw.message,
    raw,
  };
}

function cfgFor(service: string, providerId?: string): ActiveProvider {
  const c = activeConfig(service, providerId);
  if (!c) throw new Error('Eko provider not active for ' + service);
  return c;
}
const base = (c: ActiveProvider): string => (c.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
const extraStr = (c: ActiveProvider, k: string, f: string): string =>
  typeof c.extra[k] === 'string' ? (c.extra[k] as string) : f;
const rupees = (paise: number): string => (paise / 100).toFixed(2);

async function post(service: string, path: string, body: Record<string, unknown>, providerId?: string): Promise<ProviderResult> {
  const c = cfgFor(service, providerId);
  const initiatorId = c.partnerId;
  const userCode = extraStr(c, 'user_code', '');
  try {
    const raw = await httpJson<EkoResponse>(`${base(c)}${path}`, {
      method: 'POST',
      headers: signHeaders(c),
      body: { initiator_id: initiatorId, user_code: userCode, ...body },
    });
    return mapResponse(raw);
  } catch (err) {
    if (err instanceof HttpError) {
      const b = err.body as EkoResponse | undefined;
      if (b && (b.status !== undefined || b.data)) return mapResponse(b);
      return { status: 'failed', message: `Eko HTTP ${err.status}`, raw: err.body };
    }
    return { status: 'pending', message: (err as Error).message };
  }
}

export const ekoDmt: DmtProvider = {
  name: 'eko',
  transfer(input: DmtTransferInput): Promise<ProviderResult> {
    const c = cfgFor('dmt', input.providerId);
    return post('dmt', extraStr(c, 'dmt_path', '/transactions'), {
      client_ref_id: input.reference,
      amount: rupees(input.amountPaise),
      recipient_name: input.beneficiaryName,
      account: input.accountNumber,
      ifsc: input.ifsc,
      channel: input.mode === 'NEFT' ? 2 : input.mode === 'RTGS' ? 3 : 1, // 1 IMPS · 2 NEFT · 3 RTGS
    }, input.providerId);
  },
};

export const ekoBbps: BbpsProvider = {
  name: 'eko',
  pay(input: BbpsPayInput): Promise<ProviderResult> {
    const c = cfgFor('bbps', input.providerId);
    return post('bbps', extraStr(c, 'bbps_path', '/billpayments/bbps/paybill'), {
      client_ref_id: input.reference,
      amount: rupees(input.amountPaise),
      operator_id: input.billerId,
      utility_acc_no: input.consumerNumber,
      confirmation_mobile_no: extraStr(c, 'confirmation_mobile_no', ''),
    }, input.providerId);
  },
};

export const ekoRecharge: RechargeProvider = {
  name: 'eko',
  recharge(input: RechargeInput): Promise<ProviderResult> {
    const c = cfgFor('recharge', input.providerId);
    return post('recharge', extraStr(c, 'recharge_path', '/recharges'), {
      client_ref_id: input.reference,
      amount: rupees(input.amountPaise),
      operator_id: input.operator,
      mobile_no: input.number,
    }, input.providerId);
  },
};

export const ekoAeps: AepsProvider = {
  name: 'eko',
  execute(input: AepsInput): Promise<ProviderResult> {
    const c = cfgFor('aeps', input.providerId);
    return post('aeps', extraStr(c, 'aeps_path', '/aeps/cashwithdrawal'), {
      client_ref_id: input.reference,
      transaction_type: input.txnType,
      amount: rupees(input.amountPaise),
      aadhaar: input.aadhaarNumber ?? input.aadhaarRef,
      bank_iin: input.bankIin,
      customer_mobile: input.mobile,
      pidData: input.pidData,
    }, input.providerId);
  },
};

export const ekoGeneric: GenericServiceProvider = {
  name: 'eko',
  execute(service: string, input: GenericServiceInput): Promise<ProviderResult> {
    const c = cfgFor(service, input.providerId);
    return post(service, extraStr(c, `${service}_path`, `/${service.replace(/_/g, '-')}`), {
      client_ref_id: input.reference,
      amount: rupees(input.amountPaise),
      ...(input.meta ?? {}),
    }, input.providerId);
  },
};
