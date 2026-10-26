import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';
import { logger } from '../config/logger';
import { recordError } from '../modules/telemetry/error.service';

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
}

/** 404 for unmatched routes. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.path}`));
}

/** Central error serialiser — the only place that formats error responses. */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // next is required for Express to treat this as an error handler.
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // Map common Postgres errors to clean responses.
  const pg = err as PgError;
  if (pg && pg.code === '23505') {
    res.status(409).json({
      error: { code: 'conflict', message: 'Resource already exists', details: pg.detail },
    });
    return;
  }
  if (pg && pg.code === '23503') {
    res.status(400).json({
      error: { code: 'bad_request', message: 'Referenced resource does not exist' },
    });
    return;
  }

  logger.error({ err }, 'unhandled error');
  // Self-report the unhandled 5xx so it shows in the admin Error Monitor and can
  // be sent to AI triage. Fire-and-forget; recordError never throws.
  const e = err as { message?: string; stack?: string };
  void recordError({
    source: 'api',
    message: e?.message || 'Internal server error',
    stack: e?.stack ?? null,
    route: `${req.method} ${req.path}`,
    userId: (req as Request & { user?: { id?: string } }).user?.id ?? null,
    userAgent: req.get('user-agent') ?? null,
  });
  res.status(500).json({
    error: { code: 'internal_error', message: 'Internal server error' },
  });
}
