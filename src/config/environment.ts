import { z } from 'zod';

export const environmentSchema = z
  .object({
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
  })
  .transform((environment) => ({
    ...environment,
    SWAGGER_ENABLED:
      environment.SWAGGER_ENABLED ?? environment.NODE_ENV !== 'production',
  }));

export type Environment = z.infer<typeof environmentSchema>;
