import { Request, Response, Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../config/logger';
import { startAuth, handleCallback, digilockerEnabled } from './digilocker.service';

const router = Router();

function origin(req: Request): string {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

// Is DigiLocker available? (shown to members so the button only appears when set)
router.get('/status', requireAuth, asyncHandler(async (_req: Request, res: Response) => {
  res.json({ enabled: await digilockerEnabled() });
}));

// Begin verification — returns the DigiLocker authorize URL to redirect to.
router.post('/start', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const base = origin(req);
  const out = await startAuth(req.user.id, {
    fallbackRedirect: `${base}/api/v1/digilocker/callback`,
    returnUrl: typeof req.body?.return_url === 'string' ? req.body.return_url : undefined,
  });
  res.json(out);
}));

// OAuth redirect target (public — the member's browser lands here from
// DigiLocker). Records the verified KYC, then bounces back to the panel.
router.get('/callback', asyncHandler(async (req: Request, res: Response) => {
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  const err = String(req.query.error || '');
  const panel = (url: string) => res.redirect(url);
  if (err) return panel(`${origin(req)}/#/kyc?digilocker=cancelled`);
  if (!code || !state) return panel(`${origin(req)}/#/kyc?digilocker=error`);
  try {
    const { returnUrl } = await handleCallback(code, state);
    const dest = returnUrl || `${origin(req)}/#/kyc?digilocker=success`;
    return panel(dest);
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'DigiLocker callback failed');
    return panel(`${origin(req)}/#/kyc?digilocker=error`);
  }
}));

export default router;
