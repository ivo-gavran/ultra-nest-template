import { isIP } from 'node:net';
import { z } from 'zod';

export const integerEnv = (min: number, max: number, fallback: string) =>
  z
    .string()
    .regex(/^\d+$/, 'Must be a non-negative decimal integer')
    .default(fallback)
    .pipe(z.coerce.number<string>().int().min(min).max(max));

const proxyEntrySchema = z.string().refine((value) => {
  if (['loopback', 'linklocal', 'uniquelocal'].includes(value)) return true;
  const slash = value.lastIndexOf('/');
  if (slash === -1) return isIP(value) > 0;
  const address = value.slice(0, slash);
  const prefixText = value.slice(slash + 1);
  // Reject malformed prefixes explicitly: '' (Number('') is 0), signs, junk.
  if (!/^\d+$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  const version = isIP(address);
  // /0 trusts every source for forwarding headers: blanket trust, reject.
  if (prefix === 0) return false;
  return version > 0 && prefix <= (version === 4 ? 32 : 128);
}, 'Must be an IP address, CIDR range (prefix 1-32/1-128, no /0), loopback, linklocal or uniquelocal');

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
    // Rate limiting. TTLs are milliseconds (@nestjs/throttler convention).
    RATE_LIMIT_GLOBAL_LIMIT: integerEnv(1, 100_000, '100'),
    RATE_LIMIT_GLOBAL_TTL_MS: integerEnv(1_000, 3_600_000, '60000'),
    RATE_LIMIT_AUTH_LIMIT: integerEnv(1, 10_000, '5'),
    RATE_LIMIT_AUTH_TTL_MS: integerEnv(1_000, 3_600_000, '60000'),
    RATE_LIMIT_AUTH_BLOCK_MS: integerEnv(1_000, 3_600_000, '300000'),
    RATE_LIMIT_ACCOUNT_LIMIT: integerEnv(1, 10_000, '3'),
    RATE_LIMIT_ACCOUNT_TTL_MS: integerEnv(1_000, 3_600_000, '60000'),
    // `false` (default) ignores forwarding headers; otherwise an explicit
    // Express trust-proxy value: hop count or comma-separated IPs/CIDRs.
    TRUST_PROXY: z
      .union([
        z.literal('false'),
        z
          .string()
          .regex(/^\d+$/, 'Must be a proxy hop count')
          .pipe(z.coerce.number<string>().int().min(1).max(10)),
        z
          .string()
          .transform((value) => value.split(',').map((entry) => entry.trim()))
          .pipe(z.array(proxyEntrySchema).min(1)),
      ])
      .default('false'),
    REQUEST_BODY_LIMIT_BYTES: integerEnv(1_024, 1_048_576, '16384'),
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
