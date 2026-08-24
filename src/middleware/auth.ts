import { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { verifyAccessToken } from '../utils/jwt';
import { query } from '../../db';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; role: string };
    }
  }
}

/** API keys issued to AI-agent staff use this prefix (Bearer tpk_...). */
export const API_KEY_PREFIX = 'tpk_';

export function hashApiKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Require a valid Bearer credential; attaches req.user.
 *   - a JWT access token (interactive users), or
 *   - a revocable staff API key `tpk_...` (AI-agent staff): looked up by hash,
 *     must be un-revoked and its user active.
 */
export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Missing Bearer token');
  }
  const token = header.slice('Bearer '.length).trim();

  if (token.startsWith(API_KEY_PREFIX)) {
    const { rows } = await query<{ user_id: string; role: string; status: string; token_id: string }>(
      `SELECT t.id AS token_id, t.user_id, u.role, u.status
         FROM staff_api_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL
        LIMIT 1`,
      [hashApiKey(token)],
    );
    const row = rows[0];
    if (!row) throw ApiError.unauthorized('Invalid or revoked API key');
    if (row.status !== 'active') throw ApiError.forbidden('Staff account is not active');
    req.user = { id: row.user_id, role: row.role };
    // Best-effort last-used stamp; never blocks the request.
    query('UPDATE staff_api_tokens SET last_used_at = now() WHERE id = $1', [row.token_id]).catch(() => {});
    return next();
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role };
    return next();
  } catch {
    throw ApiError.unauthorized('Invalid or expired token');
  }
});

/** Restrict a route to specific roles (use after requireAuth). */
export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) throw ApiError.unauthorized();
    if (!roles.includes(req.user.role)) throw ApiError.forbidden();
    next();
  };
}
