import { Request, Response } from 'express';
import { ApiError } from '../../utils/ApiError';
import * as authService from './auth.service';

export async function requestSignupOtp(req: Request, res: Response): Promise<void> {
  const result = await authService.requestSignupOtp(req.body.phone, req.body.email);
  res.status(200).json(result);
}

export async function signup(req: Request, res: Response): Promise<void> {
  const result = await authService.signup(req.body);
  res.status(201).json(result);
}

export async function login(req: Request, res: Response): Promise<void> {
  const result = await authService.login(req.body, req.ip);
  res.status(200).json(result);
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const result = await authService.refresh(req.body.refresh_token);
  res.status(200).json(result);
}

export async function logout(req: Request, res: Response): Promise<void> {
  await authService.logout(req.body.refresh_token);
  res.status(204).send();
}

export async function me(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const user = await authService.getUserById(req.user.id);
  res.status(200).json({ user });
}

export async function forgotPassword(req: Request, res: Response): Promise<void> {
  const result = await authService.forgotPassword(req.body.identifier);
  // Generic response to avoid account enumeration; dev_code only in non-prod.
  res.status(200).json({ message: 'If the account exists, a reset code has been sent.', ...result });
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  await authService.resetPassword(req.body.identifier, req.body.code, req.body.new_password);
  res.status(200).json({ message: 'Password updated. Please log in.' });
}
