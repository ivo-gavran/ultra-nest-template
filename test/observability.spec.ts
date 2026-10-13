import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import type { ErrorEvent } from '@sentry/nestjs';
import { loadEnvironment } from '../src/config/load-environment.js';
import { telemetryEnvironmentSchema } from '../src/config/telemetry.js';
import {
  sanitizeErrorMessage,
  serializeError,
} from '../src/modules/observability/redaction.js';
import {
  currentRequestId,
  runWithRequestContext,
  selectRequestId,
} from '../src/modules/observability/request-context.js';
import { scrubEvent } from '../src/modules/observability/sentry.js';
import { CapturingJsonLogger } from './helpers/observability.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('Request IDs', () => {
  it('accepts bounded opaque IDs and replaces anything else', () => {
    for (const id of [
      'a'.repeat(16),
      'A-b_c'.repeat(12) + 'abcd',
      '0f8fad5b-d9cb-469f-a165-70867728950e',
    ])
      expect(selectRequestId(id)).toBe(id);
    for (const value of [
      undefined,
      '',
      'a'.repeat(15),
      'a'.repeat(65),
      'contains spaces in it',
      'line\nbreak-injected-id',
      '{"level":"error"}-------',
      'user@example.test-padding',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
      'aaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbb',
      ['aaaaaaaaaaaaaaaa'],
    ])
      expect(selectRequestId(value)).toMatch(UUID);
    expect(selectRequestId(undefined)).not.toBe(selectRequestId(undefined));
  });

  it('isolates context between concurrent async flows', async () => {
    const ids = Array.from({ length: 50 }, (_, index) =>
      `request-${index}`.padEnd(16, 'x'),
    );
    const seen = await Promise.all(
      ids.map((requestId, index) =>
        runWithRequestContext({ requestId }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 50 - index));
          await Promise.resolve();
          return currentRequestId();
        }),
      ),
    );
    expect(seen).toEqual(ids);
    expect(currentRequestId()).toBeUndefined();
  });
});

describe('Error redaction', () => {
  it('keeps the first line and masks values embedded in messages', () => {
    const cases: [string, string[]][] = [
      [
        'Failed query: select * from users where email = $1\nparams: leak@example.test,hunter2',
        ['leak@example.test', 'hunter2'],
      ],
      [
        'invalid input syntax for type uuid: "not-a-uuid-secret"',
        ['not-a-uuid-secret'],
      ],
      [
        'connect ECONNREFUSED 10.1.2.3:5432 postgresql://app:pw@db:5432/app',
        ['10.1.2.3', 'app:pw', 'postgresql://'],
      ],
      [
        'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl rejected',
        ['eyJhbGciOiJIUzI1NiJ9'],
      ],
      [
        'session 0f8fad5b-d9cb-469f-a165-70867728950e for owner@example.test',
        ['0f8fad5b', 'owner@example.test'],
      ],
      [
        "value 'single quoted secret' and `backtick secret`",
        ['quoted secret', 'backtick secret'],
      ],
      ['peer fe80::1ff:fe23:4567:890a refused', ['fe80::1ff']],
    ];
    for (const [message, leaked] of cases) {
      const sanitized = sanitizeErrorMessage(message)!;
      expect(sanitized).not.toContain('\n');
      for (const value of leaked) expect(sanitized).not.toContain(value);
    }
    expect(
      sanitizeErrorMessage(
        "Cannot read properties of undefined (reading 'id')",
      ),
    ).toBe('Cannot read properties of undefined (reading [redacted])');
    expect(
      sanitizeErrorMessage('Failed query: select $1::int, x::text from t'),
    ).toBe('Failed query: select $1::int, x::text from t');
    expect(sanitizeErrorMessage('connect ECONNREFUSED ::1:5432')).toBe(
      'connect ECONNREFUSED [redacted]',
    );
    expect(sanitizeErrorMessage('x'.repeat(500))!.length).toBeLessThanOrEqual(
      201,
    );
    expect(sanitizeErrorMessage(42)).toBeUndefined();
  });

  it('serializes only type, code, sanitized message, frames and bounded causes', () => {
    const cause = Object.assign(
      new Error('duplicate key "owner@example.test"'),
      {
        code: '23505',
        detail: 'Key (email)=(owner@example.test) already exists.',
      },
    );
    const error = Object.assign(
      new Error(
        'Failed query: insert into users\nparams: owner@example.test,secret-hash',
        {
          cause: new Error('level 1', {
            cause: new Error('level 2', { cause }),
          }),
        },
      ),
      {
        query: 'insert into users',
        params: ['owner@example.test', 'secret-hash'],
      },
    );
    error.name = 'DrizzleQueryError';
    const safe = serializeError(error);
    const text = JSON.stringify(safe);
    expect(safe.type).toBe('DrizzleQueryError');
    expect(safe.message).toBe('Failed query: insert into users');
    expect(safe.stack?.every((frame) => frame.startsWith('at '))).toBe(true);
    expect(safe.cause?.cause?.message).toBe('level 2');
    expect(safe.cause?.cause?.cause).toBeUndefined();
    for (const leaked of [
      'owner@example.test',
      'secret-hash',
      'params',
      'detail',
    ])
      expect(text).not.toContain(leaked);
    expect(
      serializeError(Object.assign(new Error('x'), { code: 'not a code!' })),
    ).not.toHaveProperty('code');
    expect(serializeError('thrown string')).toEqual({ type: 'Error' });
  });
});

describe('JSON logger', () => {
  const capture = () => {
    const logger = new CapturingJsonLogger('test-service');
    return { logger, records: logger.records };
  };

  it('writes Nest-compatible records with service and request correlation', () => {
    const { logger, records } = capture();
    runWithRequestContext({ requestId: 'r'.repeat(16) }, () =>
      logger.log(
        'http.request.completed',
        {
          method: 'GET',
          route: '/api/v1/users/:id',
          statusCode: 200,
          durationMs: 1.5,
        },
        'HTTP',
      ),
    );
    logger.log('outside');
    expect(records[0]).toEqual({
      timestamp: expect.any(Number),
      level: 'log',
      service: 'test-service',
      pid: process.pid,
      context: 'HTTP',
      message: 'http.request.completed',
      requestId: 'r'.repeat(16),
      method: 'GET',
      route: '/api/v1/users/:id',
      statusCode: 200,
      durationMs: 1.5,
    });
    expect(records[1]).not.toHaveProperty('requestId');
    expect(records[1]).not.toHaveProperty('traceId');
  });

  it('drops non-allowlisted params, objects and invalid field values', () => {
    const { logger, records } = capture();
    logger.log('event', {
      email: 'user@example.test',
      password: 'pw',
      headers: { cookie: 'refresh=secret' },
      method: 'GET /x?token=secret',
      statusCode: '200',
      route: 'r'.repeat(300),
    });
    logger.log({ user: { email: 'user@example.test' } });
    logger.warn(new Map([['token', 'secret']]));
    const text = JSON.stringify(records);
    for (const leaked of [
      'user@example.test',
      'pw',
      'refresh=secret',
      'token=secret',
    ])
      expect(text).not.toContain(leaked);
    expect(Object.keys(records[0]).sort()).toEqual([
      'level',
      'message',
      'pid',
      'service',
      'timestamp',
    ]);
    expect(records[1].message).toBe('[non-string message omitted]');
  });

  it('serializes errors through the redaction allowlist', () => {
    const { logger, records } = capture();
    const error = Object.assign(
      new Error('Failed query: select $1\nparams: owner@example.test'),
      { query: 'select $1', params: ['owner@example.test'] },
    );
    logger.error(error);
    logger.error('http.request.failed', error);
    logger.error(
      'job failed',
      'Error: boom owner@example.test\n    at fn (file.js:1:1)',
    );
    const text = JSON.stringify(records);
    expect(text).not.toContain('owner@example.test');
    expect(records[0]).toMatchObject({
      level: 'error',
      message: 'Failed query: select $1',
      error: { type: 'Error', message: 'Failed query: select $1' },
    });
    expect(records[1].message).toBe('http.request.failed');
    expect(records[2].error).toEqual({ stack: ['at fn (file.js:1:1)'] });
  });

  it('is used by static Nest loggers once installed', () => {
    const { logger, records } = capture();
    Logger.overrideLogger(logger);
    try {
      new Logger('Static').log('static.event');
    } finally {
      Logger.overrideLogger(false);
    }
    expect(records).toEqual([
      expect.objectContaining({ context: 'Static', message: 'static.event' }),
    ]);
  });
});

describe('Telemetry configuration', () => {
  const parse = (env: Record<string, string>) =>
    telemetryEnvironmentSchema.safeParse(env);
  const issues = (env: Record<string, string>) => {
    const result = parse(env);
    expect(result.success).toBe(false);
    return result.error!.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
  };

  it('is disabled by default with conservative settings', () => {
    expect(
      telemetryEnvironmentSchema.parse({
        SENTRY_DSN: '',
        OTEL_EXPORTER_OTLP_ENDPOINT: '',
      }),
    ).toEqual({
      NODE_ENV: 'development',
      OTEL_SERVICE_NAME: 'ultra-nest-template',
      SENTRY_DSN: undefined,
      OTEL_ENABLED: false,
      OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
      OTEL_EXPORTER_OTLP_HEADERS: undefined,
      OTEL_EXPORTER_OTLP_TIMEOUT: 5000,
      OTEL_TRACES_SAMPLER_ARG: 0.1,
      OTEL_METRIC_EXPORT_INTERVAL: 60000,
    });
  });

  it('parses enabled exporter settings', () => {
    expect(
      telemetryEnvironmentSchema.parse({
        OTEL_ENABLED: 'true',
        OTEL_SERVICE_NAME: 'api.prod-1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test:4318/',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20abc,x-team=api',
        OTEL_EXPORTER_OTLP_TIMEOUT: '2000',
        OTEL_TRACES_SAMPLER_ARG: '1',
        SENTRY_DSN: 'https://public@o1.ingest.sentry.io/123',
      }),
    ).toMatchObject({
      OTEL_ENABLED: true,
      OTEL_SERVICE_NAME: 'api.prod-1',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test:4318',
      OTEL_EXPORTER_OTLP_HEADERS: {
        authorization: 'Bearer abc',
        'x-team': 'api',
      },
      OTEL_EXPORTER_OTLP_TIMEOUT: 2000,
      OTEL_TRACES_SAMPLER_ARG: 1,
      SENTRY_DSN: 'https://public@o1.ingest.sentry.io/123',
    });
  });

  it.each([
    [{ OTEL_ENABLED: 'true' }, 'OTEL_EXPORTER_OTLP_ENDPOINT'],
    [{ OTEL_ENABLED: 'yes' }, 'OTEL_ENABLED'],
    [
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'grpc://collector:4317' },
      'OTEL_EXPORTER_OTLP_ENDPOINT',
    ],
    [
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://user:private-value@collector' },
      'OTEL_EXPORTER_OTLP_ENDPOINT',
    ],
    [
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector?token=private-value' },
      'OTEL_EXPORTER_OTLP_ENDPOINT',
    ],
    [
      { OTEL_EXPORTER_OTLP_HEADERS: 'authorization' },
      'OTEL_EXPORTER_OTLP_HEADERS',
    ],
    [
      { OTEL_EXPORTER_OTLP_HEADERS: 'bad key=private-value' },
      'OTEL_EXPORTER_OTLP_HEADERS',
    ],
    [{ OTEL_TRACES_SAMPLER_ARG: '1.5' }, 'OTEL_TRACES_SAMPLER_ARG'],
    [{ OTEL_TRACES_SAMPLER_ARG: '-0.1' }, 'OTEL_TRACES_SAMPLER_ARG'],
    [{ OTEL_TRACES_SAMPLER_ARG: 'NaN' }, 'OTEL_TRACES_SAMPLER_ARG'],
    [{ OTEL_EXPORTER_OTLP_TIMEOUT: '60000' }, 'OTEL_EXPORTER_OTLP_TIMEOUT'],
    [{ OTEL_METRIC_EXPORT_INTERVAL: '100' }, 'OTEL_METRIC_EXPORT_INTERVAL'],
    [{ OTEL_SERVICE_NAME: 'bad name\nprivate-value' }, 'OTEL_SERVICE_NAME'],
    [{ SENTRY_DSN: 'not-a-url-private-value' }, 'SENTRY_DSN'],
    [{ SENTRY_DSN: 'https://sentry.example.test/1' }, 'SENTRY_DSN'],
    [
      { SENTRY_DSN: 'https://key:private-value@sentry.example.test/1' },
      'SENTRY_DSN',
    ],
    [
      {
        NODE_ENV: 'production',
        SENTRY_DSN: 'http://key@sentry.example.test/1',
      },
      'SENTRY_DSN',
    ],
  ])('rejects %j without echoing the value', (env, key) => {
    const found = issues(env);
    expect(found.map((issue) => issue.path)).toContain(key);
    expect(JSON.stringify(found)).not.toContain('private-value');
  });

  it('loads .env with process overrides and reports only keys and rules', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nest-pr12-telemetry-'));
    try {
      writeFileSync(
        join(cwd, '.env'),
        'OTEL_ENABLED=true\nOTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318\nOTEL_SERVICE_NAME=from-file\n',
      );
      expect(
        loadEnvironment(
          telemetryEnvironmentSchema,
          { OTEL_SERVICE_NAME: 'from-env' },
          cwd,
        ),
      ).toMatchObject({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
        OTEL_SERVICE_NAME: 'from-env',
      });
      expect(() =>
        loadEnvironment(
          telemetryEnvironmentSchema,
          { SENTRY_DSN: 'https://key:private-value@sentry.example.test/1' },
          cwd,
        ),
      ).toThrow(/^Config validation error: SENTRY_DSN: Must be a Sentry DSN/);
      try {
        loadEnvironment(
          telemetryEnvironmentSchema,
          { OTEL_EXPORTER_OTLP_HEADERS: 'x=1,broken private-value' },
          cwd,
        );
      } catch (error) {
        expect((error as Error).message).not.toContain('private-value');
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('Sentry event scrubbing', () => {
  it('keeps only allowlisted tags and sanitized exception values', () => {
    const event = {
      event_id: 'e',
      message: 'boom owner@example.test\nsecond line',
      request: {
        url: 'https://api.example.test/x?token=secret',
        headers: { cookie: 'c' },
      },
      user: { email: 'owner@example.test', ip_address: '10.0.0.1' },
      extra: { body: { password: 'pw' } },
      breadcrumbs: [{ message: 'pw' }],
      server_name: 'host-1',
      modules: { pg: '8' },
      tags: {
        request_id: 'r'.repeat(16),
        service: 's',
        'user.email': 'owner@example.test',
      },
      contexts: {
        trace: { trace_id: 't', span_id: 's' },
        os: { name: 'linux' },
        culture: {},
      },
      exception: {
        values: [
          {
            type: 'DrizzleQueryError',
            value: 'Failed query: select $1\nparams: owner@example.test',
            stacktrace: {
              frames: [
                {
                  function: 'fn',
                  vars: { password: 'pw' },
                  pre_context: ['pw'],
                  context_line: 'pw',
                  post_context: ['pw'],
                },
              ],
            },
          },
        ],
      },
    } as unknown as ErrorEvent;
    const scrubbed = scrubEvent(event);
    const text = JSON.stringify(scrubbed);
    for (const leaked of [
      'owner@example.test',
      'pw',
      'token=secret',
      'host-1',
      '10.0.0.1',
      'linux',
      'cookie',
    ])
      expect(text).not.toContain(leaked);
    expect(scrubbed.tags).toEqual({ request_id: 'r'.repeat(16), service: 's' });
    expect(scrubbed.contexts).toEqual({
      trace: { trace_id: 't', span_id: 's' },
    });
    expect(scrubbed.exception?.values?.[0].value).toBe(
      'Failed query: select $1',
    );
    expect(scrubbed.message).toBe('boom [redacted]');
  });
});
