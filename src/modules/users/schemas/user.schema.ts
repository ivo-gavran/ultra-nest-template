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

export const adminUpdateUserSchema = z
  .strictObject({
    email: emailSchema.optional(),
    displayName: displayNameSchema.optional(),
    role: z.enum(['user', 'admin']).optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    {
      message: 'At least one update field is required',
    },
  );

export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export const userParamsSchema = z.strictObject({ id: z.uuid() });
export const userQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.uuid().optional(),
  search: z.string().trim().min(1).max(100).optional(),
  sort: z.enum(['createdAt', 'email']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export const publicUserResponseSchema = publicUserSchema.extend({
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const userPageSchema = z.strictObject({
  items: z.array(publicUserResponseSchema),
  nextCursor: z.uuid().nullable(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type PublicUser = z.infer<typeof publicUserSchema>;
export type AdminUpdateUserInput = z.infer<typeof adminUpdateUserSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type UserParams = z.infer<typeof userParamsSchema>;
export type UserQuery = z.infer<typeof userQuerySchema>;
