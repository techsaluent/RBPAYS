import { env } from '../config/env';
import {
  BbpsProvider,
  DmtProvider,
  GatewayProvider,
  PayoutProvider,
  RechargeProvider,
} from './types';
import {
  sandboxBbps,
  sandboxDmt,
  sandboxGateway,
  sandboxPayout,
  sandboxRecharge,
} from './sandbox';
import { razorpayGateway, razorpayPayout } from './razorpay';
import { aggregatorBbps, aggregatorDmt, aggregatorRecharge } from './aggregator';

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

export function getGatewayProvider(): GatewayProvider {
  switch (env.PROVIDER_GATEWAY) {
    case 'razorpay':
      return razorpayGateway;
    default:
      return sandboxGateway;
  }
}
