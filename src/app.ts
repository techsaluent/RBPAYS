import path from 'path';
import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './config/logger';
import { pool } from '../db';
import apiRoutes from './routes';
import webhookRoutes from './modules/webhooks/webhooks.routes';
import { errorHandler, notFoundHandler } from './middleware/error';

export function createApp() {
  const app = express();

  // Behind Nginx/Caddy on the VPS — trust the proxy for correct client IPs.
  app.set('trust proxy', 1);

  // Strong transport + header defaults for a financial app. helmet() already
  // sets nosniff, frameguard, etc.; we extend HSTS to 2 years with preload and
  // tighten the referrer policy so URLs (which can carry ids) don't leak.
  app.use(helmet({
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  }));
  app.use(
    cors({
      origin: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map((s) => s.trim()),
      credentials: true,
    }),
  );
  // Webhooks need the raw body for HMAC signature verification, so mount them
  // with a raw parser BEFORE express.json consumes the stream.
  app.use('/api/v1/webhooks', express.raw({ type: '*/*', limit: '1mb' }), webhookRoutes);

  // Receipt uploads carry a base64 image/PDF, larger than the default JSON
  // limit; parse that one route at a higher cap (later json parser then skips).
  app.use('/api/v1/topup/proof', express.json({ limit: '6mb' }));

  // Serve uploaded receipts read-only. helmet already sends X-Content-Type-Options:
  // nosniff; only image/PDF types are ever written here (see topup.routes).
  app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads'), {
    index: false, dotfiles: 'ignore', maxAge: '1h',
  }));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(pinoHttp({ logger }));

  app.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // Tighter per-IP limiter on credential endpoints (login / signup-OTP /
  // forgot / reset). Stacks with the per-identifier lockout in auth.service.
  app.use(
    ['/api/v1/auth/login', '/api/v1/auth/forgot-password', '/api/v1/auth/reset-password', '/api/v1/auth/signup/request-otp',
     '/api/v1/auth/passkey/login/options', '/api/v1/auth/passkey/login/verify'],
    rateLimit({
      windowMs: 15 * 60_000,
      max: 30,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: { code: 'too_many_requests', message: 'Too many attempts. Please wait a few minutes.' } },
    }),
  );

  // Liveness — no DB dependency.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'tutipays-api', time: new Date().toISOString() });
  });

  // Readiness — verifies the VPS Postgres connection.
  app.get('/ready', async (_req: Request, res: Response) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not_ready' });
    }
  });

  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'TutiPays API',
      version: '0.1.0',
      docs: '/api/v1',
      modules: ['auth', 'wallet', 'topup', 'beneficiaries', 'dmt', 'bbps', 'recharge', 'payout', 'aeps', 'cms', 'card-swipe', 'upi', 'matm', 'aadhaar-pay', 'pan-card', 'wallet-transfer', 'travel', 'insurance', 'payment-gateway', 'transactions', 'kyc', 'network', 'admin', 'webhooks'],
    });
  });

  app.use('/api/v1', apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
