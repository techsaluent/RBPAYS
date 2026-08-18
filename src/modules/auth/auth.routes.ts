import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import * as controller from './auth.controller';
import { loginSchema, refreshSchema, signupSchema, forgotPasswordSchema, resetPasswordSchema, requestSignupOtpSchema } from './auth.schemas';

const router = Router();

router.post('/signup/request-otp', validate(requestSignupOtpSchema), asyncHandler(controller.requestSignupOtp));
router.post('/signup', validate(signupSchema), asyncHandler(controller.signup));
router.post('/login', validate(loginSchema), asyncHandler(controller.login));
router.post('/refresh', validate(refreshSchema), asyncHandler(controller.refresh));
router.post('/logout', validate(refreshSchema), asyncHandler(controller.logout));
router.post('/forgot-password', validate(forgotPasswordSchema), asyncHandler(controller.forgotPassword));
router.post('/reset-password', validate(resetPasswordSchema), asyncHandler(controller.resetPassword));
router.get('/me', requireAuth, asyncHandler(controller.me));

export default router;
