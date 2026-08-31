import { Request, Response, Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { changePasswordSchema, setMpinSchema, removeMpinSchema, enableTotpSchema, disableTotpSchema } from '../auth/auth.schemas';
import {
  changePassword, setMpin, removeMpin, mpinStatus,
  totpStatus, startTotpSetup, enableTotp, disableTotp,
  listSessions, revokeSession, revokeAllSessions,
} from '../auth/auth.service';

/**
 * Member self-service security: change password, set/remove login MPIN,
 * authenticator-app 2FA (TOTP), and active-session management.
 */
const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const [mpin, totp] = await Promise.all([mpinStatus(req.user.id), totpStatus(req.user.id)]);
    res.json({ ...mpin, ...totp });
  }),
);

// ---- Authenticator-app 2FA (TOTP) ---------------------------------------
router.post(
  '/2fa/setup',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    res.json(await startTotpSetup(req.user.id));
  }),
);

router.post(
  '/2fa/enable',
  validate(enableTotpSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    await enableTotp(req.user.id, req.body.token);
    res.json({ message: 'Two-factor authentication enabled.', totp_enabled: true });
  }),
);

router.delete(
  '/2fa',
  validate(disableTotpSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    await disableTotp(req.user.id, req.body.current_password);
    res.json({ message: 'Two-factor authentication disabled.', totp_enabled: false });
  }),
);

// ---- Active sessions ----------------------------------------------------
router.get(
  '/sessions',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    res.json({ sessions: await listSessions(req.user.id) });
  }),
);

router.delete(
  '/sessions/:id',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    await revokeSession(req.user.id, req.params.id);
    res.json({ message: 'Session revoked.' });
  }),
);

router.post(
  '/sessions/revoke-all',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const revoked = await revokeAllSessions(req.user.id);
    res.json({ message: 'Logged out of all sessions.', revoked });
  }),
);

router.post(
  '/password',
  validate(changePasswordSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    await changePassword(req.user.id, req.body.current_password, req.body.new_password);
    res.json({ message: 'Password changed. Please log in again.' });
  }),
);

router.post(
  '/mpin',
  validate(setMpinSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    await setMpin(req.user.id, req.body.current_password, req.body.mpin);
    res.json({ message: 'MPIN set. It will be required at your next login.', mpin_set: true });
  }),
);

router.delete(
  '/mpin',
  validate(removeMpinSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    await removeMpin(req.user.id, req.body.current_password);
    res.json({ message: 'MPIN removed.', mpin_set: false });
  }),
);

export default router;
