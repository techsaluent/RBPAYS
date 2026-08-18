import { Request, Response, Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { changePasswordSchema, setMpinSchema, removeMpinSchema } from '../auth/auth.schemas';
import { changePassword, setMpin, removeMpin, mpinStatus } from '../auth/auth.service';

/** Member self-service security: change password, set/remove login MPIN. */
const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    res.json(await mpinStatus(req.user.id));
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
