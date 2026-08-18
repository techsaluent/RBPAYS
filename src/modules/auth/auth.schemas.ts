import { z } from 'zod';

// 3–30 chars, letters/digits/._- , must start with a letter. Optional field.
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9._-]{2,29}$/, 'Username must be 3-30 chars, start with a letter (a-z, 0-9, . _ -)');

// Self-registration roles a prospect may apply for. Admin/agent are never
// self-assignable — staff accounts are created internally.
export const signupRoleSchema = z.enum(['retailer', 'distributor', 'master_distributor']);

export const signupSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  username: usernameSchema.optional(),
  email: z.string().trim().toLowerCase().email(),
  phone: z
    .string()
    .trim()
    .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128),
  // Which network post the applicant is signing up for. Defaults to retailer.
  role: signupRoleSchema.default('retailer'),
  // Optional upline: the sponsor's username, email or phone. When it resolves
  // to a higher-ranked member, the new account is linked under them.
  sponsor: z.string().trim().max(120).optional(),
});

export const loginSchema = z.object({
  // Accept email, phone or username as the identifier.
  identifier: z.string().trim().min(3),
  password: z.string().min(1),
  // Optional MPIN; required at login when the account has one set.
  mpin: z.string().trim().regex(/^\d{4,6}$/).optional(),
});

export const mpinSchema = z.string().trim().regex(/^\d{4,6}$/, 'MPIN must be 4-6 digits');

export const forgotPasswordSchema = z.object({
  identifier: z.string().trim().min(3),
});

export const resetPasswordSchema = z.object({
  identifier: z.string().trim().min(3),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  new_password: z.string().min(8).max(128),
});

export const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8).max(128),
});

export const setMpinSchema = z.object({
  current_password: z.string().min(1),
  mpin: mpinSchema,
});

export const removeMpinSchema = z.object({
  current_password: z.string().min(1),
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
