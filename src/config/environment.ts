import { z } from 'zod';

export const databaseEnvironmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z
    .string()
    .regex(/^\d+$/, 'Must be a decimal port number')
    .default('3000')
    .pipe(z.coerce.number<string>().int().min(1).max(65535)),
  DATABASE_URL: z
    .url({
      protocol: /^postgres(?:ql)?$/,
      hostname: /.+/,
      error: 'Must be a PostgreSQL URL with a hostname and database name',
    })
    .pipe(
      z.string().refine((value) => new URL(value).pathname.length > 1, {
        message: 'Must include a database name',
      }),
    ),
  SWAGGER_ENABLED: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

const originSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}, 'Must be an exact HTTPS origin (HTTP only on loopback in development)');

export const environmentSchema = databaseEnvironmentSchema
  .extend({
    AUTH_SIGNING_KEY: z
      .string()
      .regex(
        /^[a-fA-F0-9]{64}$/,
        'Must be 32 random bytes encoded as 64 hexadecimal characters',
      ),
    AUTH_TRUSTED_ORIGINS: z
      .string()
      .transform((value) => value.split(',').map((origin) => origin.trim()))
      .pipe(z.array(originSchema).min(1)),
  })
  .superRefine((environment, context) => {
    if (
      environment.NODE_ENV === 'production' &&
      environment.AUTH_TRUSTED_ORIGINS.some(
        (origin) => !origin.startsWith('https://'),
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_TRUSTED_ORIGINS'],
        message: 'Production origins require HTTPS',
      });
    }
  })
  .transform((environment) => ({
    ...environment,
    SWAGGER_ENABLED:
      environment.SWAGGER_ENABLED ?? environment.NODE_ENV !== 'production',
  }));

export type Environment = z.infer<typeof environmentSchema>;
