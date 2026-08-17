import { env } from '../config/env';
import {
  AepsProvider,
  BbpsProvider,
  CardSwipeProvider,
  CmsProvider,
  DmtProvider,
  GatewayProvider,
  GenericServiceProvider,
  PayoutProvider,
  RechargeProvider,
} from './types';
import {
  sandboxAeps,
  sandboxBbps,
  sandboxCardSwipe,
  sandboxCms,
  sandboxDmt,
  sandboxGateway,
  sandboxGeneric,
  sandboxPayout,
  sandboxRecharge,
} from './sandbox';
import { razorpayGateway, razorpayPayout } from './razorpay';
import {
  aggregatorAeps,
  aggregatorBbps,
  aggregatorCardSwipe,
  aggregatorCms,
  aggregatorDmt,
  aggregatorGeneric,
  aggregatorRecharge,
} from './aggregator';
import { activeDriver } from './registry';

/**
 * Provider registry. Each getter resolves the driver for a module: the
 * super-admin-selected active provider (from the `service_providers` table,
 * cached in the registry) wins; otherwise it falls back to env (PROVIDER_*).
 * Unknown values fall back to sandbox so the API never hard-fails on a typo —
 * the choice is logged at call sites via provider.name.
 */
function driverFor(serviceCode: string, envValue: string): string {
  return activeDriver(serviceCode) ?? envValue;
}

export function getDmtProvider(): DmtProvider {
  switch (driverFor('dmt', env.PROVIDER_DMT)) {
    case 'aggregator':
      return aggregatorDmt;
    default:
      return sandboxDmt;
  }
}

export function getBbpsProvider(): BbpsProvider {
  switch (driverFor('bbps', env.PROVIDER_BBPS)) {
    case 'aggregator':
      return aggregatorBbps;
    default:
      return sandboxBbps;
  }
}

export function getRechargeProvider(): RechargeProvider {
  switch (driverFor('recharge', env.PROVIDER_RECHARGE)) {
    case 'aggregator':
      return aggregatorRecharge;
    default:
      return sandboxRecharge;
  }
}

export function getPayoutProvider(): PayoutProvider {
  switch (driverFor('payout', env.PROVIDER_PAYOUT)) {
    case 'razorpay':
      return razorpayPayout;
    default:
      return sandboxPayout;
  }
}

export function getAepsProvider(): AepsProvider {
  return driverFor('aeps', env.PROVIDER_AEPS) === 'aggregator' ? aggregatorAeps : sandboxAeps;
}

export function getCmsProvider(): CmsProvider {
  return driverFor('cms', env.PROVIDER_CMS) === 'aggregator' ? aggregatorCms : sandboxCms;
}

export function getCardSwipeProvider(): CardSwipeProvider {
  return driverFor('card_swipe', env.PROVIDER_CARD_SWIPE) === 'aggregator'
    ? aggregatorCardSwipe
    : sandboxCardSwipe;
}

// Simple services share one generic provider, chosen per-service.
const GENERIC_ENV: Record<string, string> = {
  upi: env.PROVIDER_UPI,
  matm: env.PROVIDER_MATM,
  aadhaar_pay: env.PROVIDER_AADHAAR_PAY,
  pan_card: env.PROVIDER_PAN_CARD,
  travel: env.PROVIDER_TRAVEL,
  insurance: env.PROVIDER_INSURANCE,
};

export function getGenericProvider(service: string): GenericServiceProvider {
  return driverFor(service, GENERIC_ENV[service] ?? 'sandbox') === 'aggregator'
    ? aggregatorGeneric
    : sandboxGeneric;
}

export function getGatewayProvider(): GatewayProvider {
  switch (driverFor('payment_gateway', env.PROVIDER_GATEWAY)) {
    case 'razorpay':
      return razorpayGateway;
    default:
      return sandboxGateway;
  }
}
