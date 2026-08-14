import 'dotenv/config';

/** Read a required env var or throw at startup (fail fast). */
function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env ${name} must be an integer`);
  return n;
}

const NODE_ENV = optional('NODE_ENV', 'development');

export const env = {
  NODE_ENV,
  isProd: NODE_ENV === 'production',
  PORT: int('PORT', 8080),
  API_BASE_URL: optional('API_BASE_URL', 'http://localhost:8080'),

  // Database — either DATABASE_URL or discrete PG* values.
  DATABASE_URL: process.env.DATABASE_URL ?? '',
  PGHOST: optional('PGHOST', '127.0.0.1'),
  PGPORT: int('PGPORT', 5432),
  PGUSER: optional('PGUSER', 'rbpays'),
  PGPASSWORD: optional('PGPASSWORD', ''),
  PGDATABASE: optional('PGDATABASE', 'rbpays'),
  PGSSLMODE: optional('PGSSLMODE', 'disable'),
  PG_POOL_MAX: int('PG_POOL_MAX', 10),

  // Auth
  JWT_ACCESS_SECRET: required('JWT_ACCESS_SECRET'),
  JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET'),
  JWT_ACCESS_TTL: optional('JWT_ACCESS_TTL', '15m'),
  JWT_REFRESH_TTL: optional('JWT_REFRESH_TTL', '30d'),
  BCRYPT_ROUNDS: int('BCRYPT_ROUNDS', 12),

  // CORS
  CORS_ORIGINS: optional('CORS_ORIGINS', '*'),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: int('RATE_LIMIT_WINDOW_MS', 60_000),
  RATE_LIMIT_MAX: int('RATE_LIMIT_MAX', 120),

  // ---- Provider selection (per module) --------------------------------
  // sandbox | razorpay | aggregator. Defaults to sandbox so the API runs
  // out of the box; set real providers once you have credentials.
  PROVIDER_DMT: optional('PROVIDER_DMT', 'sandbox'),
  PROVIDER_BBPS: optional('PROVIDER_BBPS', 'sandbox'),
  PROVIDER_RECHARGE: optional('PROVIDER_RECHARGE', 'sandbox'),
  PROVIDER_PAYOUT: optional('PROVIDER_PAYOUT', 'sandbox'),
  PROVIDER_GATEWAY: optional('PROVIDER_GATEWAY', 'sandbox'),
  PROVIDER_AEPS: optional('PROVIDER_AEPS', 'sandbox'),
  PROVIDER_CMS: optional('PROVIDER_CMS', 'sandbox'),
  PROVIDER_CARD_SWIPE: optional('PROVIDER_CARD_SWIPE', 'sandbox'),
  PROVIDER_UPI: optional('PROVIDER_UPI', 'sandbox'),
  PROVIDER_MATM: optional('PROVIDER_MATM', 'sandbox'),
  PROVIDER_AADHAAR_PAY: optional('PROVIDER_AADHAAR_PAY', 'sandbox'),
  PROVIDER_PAN_CARD: optional('PROVIDER_PAN_CARD', 'sandbox'),

  HTTP_TIMEOUT_MS: int('HTTP_TIMEOUT_MS', 20_000),

  // ---- Razorpay / RazorpayX ------------------------------------------
  RAZORPAY_KEY_ID: optional('RAZORPAY_KEY_ID', ''),
  RAZORPAY_KEY_SECRET: optional('RAZORPAY_KEY_SECRET', ''),
  RAZORPAY_WEBHOOK_SECRET: optional('RAZORPAY_WEBHOOK_SECRET', ''),
  RAZORPAYX_ACCOUNT_NUMBER: optional('RAZORPAYX_ACCOUNT_NUMBER', ''),

  // ---- Aggregator (DMT / BBPS / Recharge switch, e.g. Paysprint) ------
  AGGREGATOR_BASE_URL: optional('AGGREGATOR_BASE_URL', ''),
  AGGREGATOR_API_KEY: optional('AGGREGATOR_API_KEY', ''),
  AGGREGATOR_AUTH_TOKEN: optional('AGGREGATOR_AUTH_TOKEN', ''),
  AGGREGATOR_PARTNER_ID: optional('AGGREGATOR_PARTNER_ID', ''),
  AGGREGATOR_WEBHOOK_SECRET: optional('AGGREGATOR_WEBHOOK_SECRET', ''),
} as const;
