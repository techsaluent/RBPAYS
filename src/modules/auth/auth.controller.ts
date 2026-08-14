import { Request, Response } from 'express';
import { ApiError } from '../../utils/ApiError';
import * as authService from './auth.service';

export async function signup(req: Request, res: Response): Promise<void> {
  const result = await authService.signup(req.body);
  res.status(201).json(result);
}

export async function login(req: Request, res: Response): Promise<void> {
  const result = await authService.login(req.body);
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
