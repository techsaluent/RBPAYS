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
import { aeronpayBbps, aeronpayDmt, aeronpayPayout, aeronpayRecharge } from './aeronpay';
import { ekoAeps, ekoBbps, ekoDmt, ekoGeneric, ekoRecharge } from './eko';
import { activeDriver } from './registry';

/**
 * Provider registry. Each getter resolves the driver for a module: the
 * super-admin-selected active provider (from the `service_providers` table,
 * cached in the registry) wins; otherwise it falls back to env (PROVIDER_*).
 * Unknown values fall back to sandbox so the API never hard-fails on a typo —
 * the choice is logged at call sites via provider.name.
 */
function driverFor(serviceCode: string, envValue: string, providerId?: string): string {
  return activeDriver(serviceCode, providerId) ?? envValue;
}

export function getDmtProvider(providerId?: string): DmtProvider {
  switch (driverFor('dmt', env.PROVIDER_DMT, providerId)) {
    case 'aggregator':
      return aggregatorDmt;
    case 'aeronpay':
      return aeronpayDmt;
    case 'eko':
      return ekoDmt;
    default:
      return sandboxDmt;
  }
}

export function getBbpsProvider(providerId?: string): BbpsProvider {
  switch (driverFor('bbps', env.PROVIDER_BBPS, providerId)) {
    case 'aggregator':
      return aggregatorBbps;
    case 'aeronpay':
      return aeronpayBbps;
    case 'eko':
      return ekoBbps;
    default:
      return sandboxBbps;
  }
}

export function getRechargeProvider(providerId?: string): RechargeProvider {
  switch (driverFor('recharge', env.PROVIDER_RECHARGE, providerId)) {
    case 'aggregator':
      return aggregatorRecharge;
    case 'aeronpay':
      return aeronpayRecharge;
    case 'eko':
      return ekoRecharge;
    default:
      return sandboxRecharge;
  }
}

export function getPayoutProvider(providerId?: string): PayoutProvider {
  switch (driverFor('payout', env.PROVIDER_PAYOUT, providerId)) {
    case 'razorpay':
      return razorpayPayout;
    case 'aeronpay':
      return aeronpayPayout;
    default:
      return sandboxPayout;
  }
}

export function getAepsProvider(providerId?: string): AepsProvider {
  switch (driverFor('aeps', env.PROVIDER_AEPS, providerId)) {
    case 'aggregator':
      return aggregatorAeps;
    case 'eko':
      return ekoAeps;
    default:
      return sandboxAeps;
  }
}

export function getCmsProvider(providerId?: string): CmsProvider {
  return driverFor('cms', env.PROVIDER_CMS, providerId) === 'aggregator' ? aggregatorCms : sandboxCms;
}

export function getCardSwipeProvider(providerId?: string): CardSwipeProvider {
  return driverFor('card_swipe', env.PROVIDER_CARD_SWIPE, providerId) === 'aggregator'
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

export function getGenericProvider(service: string, providerId?: string): GenericServiceProvider {
  switch (driverFor(service, GENERIC_ENV[service] ?? 'sandbox', providerId)) {
    case 'aggregator':
      return aggregatorGeneric;
    case 'eko':
      return ekoGeneric;
    default:
      return sandboxGeneric;
  }
}

export function getGatewayProvider(): GatewayProvider {
  switch (driverFor('payment_gateway', env.PROVIDER_GATEWAY)) {
    case 'razorpay':
      return razorpayGateway;
    default:
      return sandboxGateway;
  }
}
