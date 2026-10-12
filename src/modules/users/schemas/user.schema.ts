import { z } from 'zod';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email());
export const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine(
    (value) => Buffer.byteLength(value.normalize('NFKC'), 'utf8') <= 4096,
    'Password exceeds the normalized byte limit',
  );
const displayNameSchema = z.string().trim().min(1).max(100).nullable();

export const createUserSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema.optional(),
});

export const updateUserSchema = z
  .strictObject({
    email: emailSchema.optional(),
    displayName: displayNameSchema.optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    {
      message: 'At least one update field is required',
    },
  );

export const publicUserSchema = z.strictObject({
  id: z.uuid(),
  email: emailSchema,
  displayName: displayNameSchema,
  role: z.enum(['user', 'admin']),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type PublicUser = z.infer<typeof publicUserSchema>;
