import { z } from 'zod';
import { emailSchema } from '../../users/schemas/user.schema.js';

export const loginSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;
export const emptyAuthSchema = z.strictObject({}).default({});
export type EmptyAuthInput = z.infer<typeof emptyAuthSchema>;
export const accessTokenSchema = z.strictObject({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
});
