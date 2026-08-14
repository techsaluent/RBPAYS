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

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map((s) => s.trim()),
      credentials: true,
    }),
  );
  // Webhooks need the raw body for HMAC signature verification, so mount them
  // with a raw parser BEFORE express.json consumes the stream.
  app.use('/api/v1/webhooks', express.raw({ type: '*/*', limit: '1mb' }), webhookRoutes);

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

  // Liveness — no DB dependency.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'rbpays-api', time: new Date().toISOString() });
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
      name: 'RBPAYS API',
      version: '0.1.0',
      docs: '/api/v1',
      modules: ['auth', 'wallet', 'beneficiaries', 'dmt', 'bbps', 'recharge', 'payout', 'payment-gateway', 'transactions', 'kyc', 'network', 'admin', 'webhooks'],
    });
  });

  app.use('/api/v1', apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
