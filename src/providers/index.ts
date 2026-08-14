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

/**
 * Provider registry. Each getter resolves the configured provider for a module
 * from env (PROVIDER_*). Unknown values fall back to sandbox so the API never
 * hard-fails on a typo — the choice is logged at call sites via provider.name.
 */
export function getDmtProvider(): DmtProvider {
  switch (env.PROVIDER_DMT) {
    case 'aggregator':
      return aggregatorDmt;
    default:
      return sandboxDmt;
  }
}

export function getBbpsProvider(): BbpsProvider {
  switch (env.PROVIDER_BBPS) {
    case 'aggregator':
      return aggregatorBbps;
    default:
      return sandboxBbps;
  }
}

export function getRechargeProvider(): RechargeProvider {
  switch (env.PROVIDER_RECHARGE) {
    case 'aggregator':
      return aggregatorRecharge;
    default:
      return sandboxRecharge;
  }
}

export function getPayoutProvider(): PayoutProvider {
  switch (env.PROVIDER_PAYOUT) {
    case 'razorpay':
      return razorpayPayout;
    default:
      return sandboxPayout;
  }
}

export function getAepsProvider(): AepsProvider {
  return env.PROVIDER_AEPS === 'aggregator' ? aggregatorAeps : sandboxAeps;
}

export function getCmsProvider(): CmsProvider {
  return env.PROVIDER_CMS === 'aggregator' ? aggregatorCms : sandboxCms;
}

export function getCardSwipeProvider(): CardSwipeProvider {
  return env.PROVIDER_CARD_SWIPE === 'aggregator' ? aggregatorCardSwipe : sandboxCardSwipe;
}

// Simple services share one generic provider, chosen per-service via env.
const GENERIC_CHOICE: Record<string, string> = {
  upi: env.PROVIDER_UPI,
  matm: env.PROVIDER_MATM,
  aadhaar_pay: env.PROVIDER_AADHAAR_PAY,
  pan_card: env.PROVIDER_PAN_CARD,
};

export function getGenericProvider(service: string): GenericServiceProvider {
  return GENERIC_CHOICE[service] === 'aggregator' ? aggregatorGeneric : sandboxGeneric;
}

export function getGatewayProvider(): GatewayProvider {
  switch (env.PROVIDER_GATEWAY) {
    case 'razorpay':
      return razorpayGateway;
    default:
      return sandboxGateway;
  }
}
