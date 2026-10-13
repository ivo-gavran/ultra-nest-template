import { z } from 'zod';
import { integerEnv } from './environment.js';

// Read before NestJS loads so instrumentation precedes instrumented modules.
// Issue messages never include submitted values (DSNs, headers, endpoints).

const blankAsUnset = (value: unknown) => (value === '' ? undefined : value);

const endpointSchema = z
  .url({
    protocol: /^https?$/,
    hostname: /.+/,
    error: 'Must be an http(s) URL',
  })
  .refine((value) => {
    if (!URL.canParse(value)) return true;
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  }, 'Must not contain credentials, a query or a fragment')
  .transform((value) => value.replace(/\/+$/, ''));

const sentryDsnSchema = z
  .url({
    protocol: /^https?$/,
    hostname: /.+/,
    error: 'Must be a Sentry DSN URL',
  })
  .refine((value) => {
    if (!URL.canParse(value)) return true;
    const url = new URL(value);
    return (
      url.username.length > 0 &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/(?:[^/]+\/)*[^/]+$/.test(url.pathname)
    );
  }, 'Must be a Sentry DSN of the form https://<key>@<host>/<project>');

// W3C-baggage-style `key=value,key2=value2` (values percent-encoded), as in the
// OTLP exporter specification. Used for collector/vendor authentication.
const headersSchema = z.string().transform((value, context) => {
  const headers: Record<string, string> = {};
  const entries = value.split(',');
  if (entries.length > 16) {
    context.addIssue({ code: 'custom', message: 'At most 16 headers' });
    return z.NEVER;
  }
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    const key = entry.slice(0, separator).trim();
    let decoded: string;
    try {
      decoded = decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      decoded = '';
    }
    if (
      separator < 1 ||
      !/^[A-Za-z0-9-]{1,64}$/.test(key) ||
      !decoded ||
      decoded.length > 4096 ||
      /[\r\n]/.test(decoded)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Must be comma-separated key=value pairs',
      });
      return z.NEVER;
    }
    headers[key.toLowerCase()] = decoded;
  }
  return headers;
});

const ratioSchema = z
  .string()
  .regex(
    /^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/,
    'Must be a decimal ratio between 0 and 1',
  )
  .default('0.1')
  .pipe(z.coerce.number<string>().min(0).max(1));

export const telemetryEnvironmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    // Also the `service` field of every structured log record.
    OTEL_SERVICE_NAME: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/,
        'Must be 1-63 letters, digits, dots, underscores or hyphens',
      )
      .default('ultra-nest-template'),
    // Sentry is enabled exactly when a DSN is configured.
    SENTRY_DSN: z.preprocess(blankAsUnset, sentryDsnSchema.optional()),
    OTEL_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
      blankAsUnset,
      endpointSchema.optional(),
    ),
    OTEL_EXPORTER_OTLP_HEADERS: z.preprocess(
      blankAsUnset,
      headersSchema.optional(),
    ),
    // Bounds each export request, telemetry flush and Sentry close at shutdown.
    OTEL_EXPORTER_OTLP_TIMEOUT: integerEnv(1_000, 10_000, '5000'),
    OTEL_TRACES_SAMPLER_ARG: ratioSchema,
    OTEL_METRIC_EXPORT_INTERVAL: integerEnv(5_000, 300_000, '60000'),
  })
  .superRefine((environment, context) => {
    if (environment.OTEL_ENABLED && !environment.OTEL_EXPORTER_OTLP_ENDPOINT) {
      context.addIssue({
        code: 'custom',
        path: ['OTEL_EXPORTER_OTLP_ENDPOINT'],
        message: 'Required when OTEL_ENABLED=true',
      });
    }
    if (
      environment.NODE_ENV === 'production' &&
      environment.SENTRY_DSN?.startsWith('http://')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['SENTRY_DSN'],
        message: 'Production requires an HTTPS DSN',
      });
    }
  });

export type TelemetryEnvironment = z.infer<typeof telemetryEnvironmentSchema>;
