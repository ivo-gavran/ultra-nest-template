import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { InjectDrizzle } from '@nestjs/drizzle';
import { SkipThrottle } from '@nestjs/throttler';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { telemetryEnvironmentSchema } from '../../src/config/telemetry.js';
import type { Database } from '../../src/database/database.module.js';
import { currentRequestId } from '../../src/modules/observability/request-context.js';
import {
  activeTracer,
  flushTelemetry,
  shutdownTelemetry,
  startTelemetry,
} from '../../src/modules/observability/telemetry.js';
import type { TelemetryOverrides } from '../../src/modules/observability/telemetry.js';
import { createAuthApp } from '../helpers/auth-app.js';
import { authEnvironment } from '../helpers/auth-environment.js';
import { deferred } from '../helpers/deferred.js';
import {
  CapturingJsonLogger,
  TestMetricReader,
  sentryRecorder,
} from '../helpers/observability.js';
import { startTestDatabase } from '../helpers/postgres.js';

const origin = authEnvironment.AUTH_TRUSTED_ORIGINS;
const LEAKED_PARAM = 'leaked-param-value-7f3a';
const QUERY_SECRET = 'query-secret-91c2';
const RAW_ID = '123e4567-e89b-12d3-a456-426614174000';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SPAN_ATTRIBUTES = new Set([
  'http.request.method',
  'http.route',
  'http.response.status_code',
  'error.type',
]);

let gate = {
  entered: deferred<void>(),
  release: deferred<void>(),
  done: deferred<void>(),
};

@Public()
@SkipThrottle({ global: true, auth: true, account: true })
@Controller('observability-test')
class ObservabilityTestController {
  private readonly logger = new Logger('ObservabilityTest');

  constructor(@InjectDrizzle() private readonly db: Database) {}

  // A real DrizzleQueryError whose message and cause quote the bound value.
  @Get('fail/:id')
  async fail() {
    await this.db.execute(sql`select ${LEAKED_PARAM}::int`);
  }

  @Get('echo')
  async echo() {
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
    await this.db.execute(sql`select 1`);
    this.logger.log('echo.handled');
    return { requestId: currentRequestId() };
  }

  @Post('echo')
  echoBody() {
    this.logger.log('echo.body.handled');
    return { requestId: currentRequestId() };
  }

  @Get('slow')
  async slow() {
    gate.entered.resolve();
    try {
      await gate.release.promise;
      return { ok: true };
    } finally {
      gate.done.resolve();
    }
  }

  @Get('internal-error')
  internalError(): never {
    throw new InternalServerErrorException('deliberate internal failure');
  }

  @Get('unavailable')
  unavailable(): never {
    throw new ServiceUnavailableException('dependency unavailable');
  }

  @Get('bad-gateway')
  badGateway(): never {
    throw new HttpException('upstream failed', HttpStatus.BAD_GATEWAY);
  }
}

const baseTelemetry = {
  NODE_ENV: 'test',
  OTEL_SERVICE_NAME: 'observability-test',
  OTEL_ENABLED: 'true',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9',
  OTEL_EXPORTER_OTLP_TIMEOUT: '1000',
  OTEL_TRACES_SAMPLER_ARG: '1',
  SENTRY_DSN: 'https://public@sentry.example.test/1',
};

const id = (label: string) => `${label}-${'x'.repeat(16)}`.slice(0, 40);

function spanView(span: ReadableSpan) {
  return {
    name: span.name,
    kind: span.kind,
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    attributes: span.attributes,
    status: span.status,
    events: span.events.map((event) => ({
      name: event.name,
      attributes: event.attributes,
    })),
    resource: span.resource.attributes,
  };
}

async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('Observability with real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication | undefined;
  let url: string;
  let logger: CapturingJsonLogger;

  const start = async (
    telemetry: Record<string, string>,
    overrides: TelemetryOverrides = {},
    env: Record<string, string> = {},
  ) => {
    await startTelemetry(telemetryEnvironmentSchema.parse(telemetry), {
      instrumentPostgres: false,
      ...overrides,
    });
    logger = new CapturingJsonLogger(
      telemetry.OTEL_SERVICE_NAME ?? 'ultra-nest-template',
    );
    app = await createAuthApp(
      container.getConnectionUri(),
      () => Date.now(),
      logger,
      origin,
      [ObservabilityTestController],
      env,
    );
    url = await app.getUrl();
  };
  const stop = async () => {
    await app?.close();
    app = undefined;
    await shutdownTelemetry();
  };
  const logsFor = (requestId: string) =>
    logger.records.filter((record) => record.requestId === requestId);
  const completions = (requestId: string) =>
    logsFor(requestId).filter((record) =>
      ['http.request.completed', 'http.request.aborted'].includes(
        record.message as string,
      ),
    );

  beforeAll(async () => {
    container = await startTestDatabase();
  });
  afterEach(stop);
  afterAll(async () => {
    await stop();
    await container?.stop();
  });

  describe('with Sentry and OpenTelemetry enabled', () => {
    let spans: InMemorySpanExporter;
    let metrics: TestMetricReader;
    let sentry: ReturnType<typeof sentryRecorder>;

    beforeEach(async () => {
      spans = new InMemorySpanExporter();
      metrics = new TestMetricReader();
      sentry = sentryRecorder();
      await start(
        baseTelemetry,
        {
          spanExporter: spans,
          metricReader: metrics,
          sentryTransport: sentry.transport,
        },
        { REQUEST_BODY_LIMIT_BYTES: '2048', RATE_LIMIT_AUTH_LIMIT: '1' },
      );
    });

    const call = (
      requestId: string,
      path: string,
      init: RequestInit & { headers?: Record<string, string> } = {},
    ) =>
      fetch(`${url}/api/v1/${path}`, {
        ...init,
        headers: { 'X-Request-ID': requestId, ...init.headers },
      });
    const postJson = (
      requestId: string,
      path: string,
      body: string,
      from = origin,
    ) =>
      call(requestId, path, {
        method: 'POST',
        headers: { Origin: from, 'Content-Type': 'application/json' },
        body,
      });

    it('correlates every failure class with one log, safe body and Sentry only for unexpected errors', async () => {
      const cases: {
        label: string;
        status: number;
        send: (requestId: string) => Promise<Response>;
        route?: string;
      }[] = [
        {
          label: 'malformed',
          status: 400,
          send: (requestId) =>
            postJson(
              requestId,
              'observability-test/echo',
              '{"password":"pw-91c2"',
            ),
        },
        {
          label: 'unauthenticated',
          status: 401,
          route: '/api/v1/users/me',
          send: (requestId) =>
            call(requestId, `users/me?token=${QUERY_SECRET}`, {
              headers: { Authorization: 'Bearer not-a-real-token-91c2' },
            }),
        },
        {
          label: 'csrf',
          status: 403,
          send: (requestId) =>
            postJson(
              requestId,
              'observability-test/echo',
              '{}',
              'https://evil.example.test',
            ),
        },
        {
          label: 'missing',
          status: 404,
          send: (requestId) =>
            call(
              requestId,
              `missing/${RAW_ID}?email=owner@example.test&token=${QUERY_SECRET}`,
            ),
        },
        {
          label: 'oversized',
          status: 413,
          send: (requestId) =>
            postJson(
              requestId,
              'observability-test/echo',
              JSON.stringify({ value: 'x'.repeat(4096) }),
            ),
        },
        {
          label: 'throttled',
          status: 429,
          route: '/api/v1/auth/login',
          send: async (requestId) => {
            const body = JSON.stringify({
              email: 'owner@example.test',
              password: 'pw-91c2-password',
            });
            await postJson(id('warmup'), 'auth/login', body);
            return postJson(requestId, 'auth/login', body);
          },
        },
        {
          label: 'unexpected',
          status: 500,
          route: '/api/v1/observability-test/fail/:id',
          send: (requestId) =>
            call(
              requestId,
              `observability-test/fail/${RAW_ID}?token=${QUERY_SECRET}`,
            ),
        },
      ];

      for (const { label, status, send, route } of cases) {
        const requestId = id(label);
        const response = await send(requestId);
        const body = await response.text();
        expect({ label, status: response.status }).toEqual({ label, status });
        expect(response.headers.get('x-request-id')).toBe(requestId);
        expect(body).not.toMatch(
          /\s+at \S+:\d+:\d+|stack|Failed query|select |postgres/i,
        );
        if (status === 500)
          expect(JSON.parse(body)).toEqual({
            statusCode: 500,
            message: 'Internal server error',
          });
        await waitFor(() => completions(requestId).length > 0, `${label} log`);
        expect(completions(requestId)).toEqual([
          expect.objectContaining({
            level: status >= 500 ? 'warn' : 'log',
            context: 'HTTP',
            message: 'http.request.completed',
            statusCode: status,
            ...(route ? { route } : {}),
          }),
        ]);
        if (!route)
          expect(completions(requestId)[0]).not.toHaveProperty('route');
        const failures = logsFor(requestId).filter(
          (record) => record.level === 'error',
        );
        expect(failures).toHaveLength(status === 500 ? 1 : 0);
      }

      await flushTelemetry();
      const events = sentry.events();
      expect(events).toHaveLength(1);
      expect(sentry.itemTypes()).toEqual(['event']);
      const [event] = events;
      const failure = logsFor(id('unexpected')).find(
        (record) => record.level === 'error',
      )!;
      expect(failure).toMatchObject({
        context: 'ExceptionsHandler',
        message: 'http.request.failed',
        error: {
          type: 'DrizzleQueryError',
          message: 'Failed query: select $1::int',
        },
      });
      expect(event.tags).toEqual({
        service: 'observability-test',
        request_id: id('unexpected'),
        'http.request.method': 'GET',
        'http.route': '/api/v1/observability-test/fail/:id',
        trace_id: failure.traceId,
        span_id: failure.spanId,
      });
      // Linked errors: pg's DatabaseError cause, then the DrizzleQueryError.
      expect(event.exception?.values?.map((value) => value.value)).toEqual([
        'invalid input syntax for type integer: [redacted]',
        'Failed query: select $1::int',
      ]);
      for (const key of [
        'request',
        'user',
        'extra',
        'breadcrumbs',
        'server_name',
        'modules',
      ])
        expect(event).not.toHaveProperty(key);

      const exported = spans.getFinishedSpans().map(spanView);
      const failed = exported.find((span) => span.traceId === failure.traceId)!;
      expect(failed).toMatchObject({
        name: 'GET /api/v1/observability-test/fail/:id',
        kind: 1,
        status: { code: 2 },
        attributes: {
          'http.request.method': 'GET',
          'http.route': '/api/v1/observability-test/fail/:id',
          'http.response.status_code': 500,
          'error.type': '500',
        },
        events: [
          {
            name: 'exception',
            attributes: {
              'exception.type': 'DrizzleQueryError',
              'exception.message': 'Failed query: select $1::int',
            },
          },
        ],
        resource: {
          'service.name': 'observability-test',
          'deployment.environment.name': 'test',
        },
      });
      expect(Object.keys(failed.resource).sort()).toEqual([
        'deployment.environment.name',
        'service.name',
      ]);
      for (const span of exported) {
        expect(
          Object.keys(span.attributes).every((key) => SPAN_ATTRIBUTES.has(key)),
        ).toBe(true);
        expect(span.status).not.toHaveProperty('message');
      }
      expect(exported.map((span) => span.name).sort()).toEqual(
        [
          'GET',
          'GET /api/v1/observability-test/fail/:id',
          'GET /api/v1/users/me',
          'POST',
          'POST',
          'POST',
          'POST /api/v1/auth/login',
          'POST /api/v1/auth/login',
        ].sort(),
      );

      const everything = JSON.stringify([
        logger.records,
        exported,
        sentry.envelopes,
      ]);
      for (const leaked of [
        LEAKED_PARAM,
        QUERY_SECRET,
        RAW_ID,
        'owner@example.test',
        'pw-91c2',
        'not-a-real-token-91c2',
        'evil.example.test',
        '?token=',
        '?email=',
      ])
        expect({ leaked, found: everything.includes(leaked) }).toEqual({
          leaked,
          found: false,
        });
    });

    it('reports explicit 5xx HttpExceptions once and keeps deliberate 503 quiet', async () => {
      const cases: {
        label: string;
        path: string;
        status: number;
        report: boolean;
        errorType: string;
        body: Record<string, unknown>;
      }[] = [
        {
          label: 'internal',
          path: 'observability-test/internal-error',
          status: 500,
          report: true,
          errorType: 'InternalServerErrorException',
          body: {
            statusCode: 500,
            message: 'deliberate internal failure',
            error: 'Internal Server Error',
          },
        },
        {
          label: 'unavailable',
          path: 'observability-test/unavailable',
          status: 503,
          report: false,
          errorType: 'ServiceUnavailableException',
          body: {
            statusCode: 503,
            message: 'dependency unavailable',
            error: 'Service Unavailable',
          },
        },
        {
          label: 'bad-gateway',
          path: 'observability-test/bad-gateway',
          status: 502,
          report: true,
          errorType: 'HttpException',
          body: {
            statusCode: 502,
            message: 'upstream failed',
          },
        },
      ];

      for (const { label, path, status, report, body } of cases) {
        const requestId = id(label);
        const response = await call(requestId, path);
        const text = await response.text();
        expect({ label, status: response.status }).toEqual({ label, status });
        expect(response.headers.get('x-request-id')).toBe(requestId);
        expect(JSON.parse(text)).toEqual(body);
        expect(text).not.toMatch(/\s+at \S+:\d+:\d+|stack|postgres/i);
        await waitFor(() => completions(requestId).length > 0, `${label} log`);
        expect(completions(requestId)).toEqual([
          expect.objectContaining({
            level: 'warn',
            message: 'http.request.completed',
            statusCode: status,
            route: `/api/v1/${path}`,
          }),
        ]);
        const failures = logsFor(requestId).filter(
          (record) => record.message === 'http.request.failed',
        );
        expect(failures).toHaveLength(report ? 1 : 0);
      }

      await flushTelemetry();
      const events = sentry.events();
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.tags?.request_id).sort()).toEqual(
        [id('bad-gateway'), id('internal')].sort(),
      );

      const exported = spans.getFinishedSpans().map(spanView);
      for (const { label, path, status, report, errorType } of cases) {
        const requestId = id(label);
        const failure = logsFor(requestId).find(
          (record) => record.message === 'http.request.failed',
        );
        const span = exported.find(
          (item) =>
            item.name === `GET /api/v1/${path}` &&
            item.attributes['http.response.status_code'] === status,
        )!;
        expect(span.status).toEqual({ code: 2 });
        expect(span.status).not.toHaveProperty('message');
        if (report) {
          expect(failure).toMatchObject({
            context: 'ExceptionsHandler',
            message: 'http.request.failed',
            error: { type: errorType },
          });
          expect(span.events).toEqual([
            expect.objectContaining({
              name: 'exception',
              attributes: expect.objectContaining({
                'exception.type': errorType,
              }) as unknown,
            }),
          ]);
          expect(span.traceId).toBe(failure!.traceId);
        } else {
          expect(span.events).toEqual([]);
        }
      }
    });

    it('keeps request IDs isolated across concurrent requests and after body parsing', async () => {
      const ids = Array.from({ length: 25 }, (_, index) =>
        id(`concurrent-${index}`),
      );
      const responses = await Promise.all(
        ids.map((requestId) => call(requestId, 'observability-test/echo')),
      );
      for (const [index, response] of responses.entries()) {
        expect(response.headers.get('x-request-id')).toBe(ids[index]);
        expect(await response.json()).toEqual({ requestId: ids[index] });
      }
      const handled = logger.records.filter(
        (record) => record.message === 'echo.handled',
      );
      expect(handled.map((record) => record.requestId).sort()).toEqual(
        [...ids].sort(),
      );
      for (const record of handled) {
        const completion = completions(record.requestId as string)[0];
        expect(record.traceId).toBe(completion.traceId);
      }

      const posted = await postJson(
        id('body'),
        'observability-test/echo',
        '{"a":1}',
      );
      expect(await posted.json()).toEqual({ requestId: id('body') });
      expect(logsFor(id('body')).map((record) => record.message)).toEqual([
        'echo.body.handled',
        'http.request.completed',
      ]);
    });

    it('generates IDs for missing or unsafe inbound values and exposes them to CORS clients', async () => {
      const seen = new Set<string>();
      for (const inbound of [
        undefined,
        'short',
        'x'.repeat(65),
        'has space padding!!',
        'a.b.c-jwt-like-value',
      ]) {
        const response = await fetch(`${url}/api/v1/health/live`, {
          headers: inbound === undefined ? {} : { 'X-Request-ID': inbound },
        });
        const selected = response.headers.get('x-request-id')!;
        expect(selected).toMatch(UUID);
        seen.add(selected);
      }
      expect(seen.size).toBe(5);

      const preflight = await fetch(`${url}/api/v1/observability-test/echo`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,x-request-id',
        },
      });
      expect(preflight.headers.get('access-control-allow-headers')).toContain(
        'X-Request-ID',
      );
      const simple = await fetch(`${url}/api/v1/health/live`, {
        headers: { Origin: origin },
      });
      expect(simple.headers.get('access-control-expose-headers')).toBe(
        'X-Request-ID',
      );
    });

    it('continues inbound W3C trace context and correlates logs with it', async () => {
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const parentId = '00f067aa0ba902b7';
      await call(id('traced'), 'observability-test/echo', {
        headers: {
          traceparent: `00-${traceId}-${parentId}-01`,
          baggage: 'user.email=owner@example.test',
        },
      });
      await call(id('unsampled'), 'observability-test/echo', {
        headers: { traceparent: `00-${'1'.repeat(32)}-${parentId}-00` },
      });
      await flushTelemetry();
      const exported = spans.getFinishedSpans().map(spanView);
      expect(exported).toHaveLength(1);
      expect(exported[0]).toMatchObject({
        name: 'GET /api/v1/observability-test/echo',
        traceId,
        parentSpanId: parentId,
      });
      expect(completions(id('traced'))[0]).toMatchObject({
        traceId,
        spanId: exported[0].spanId,
      });
      expect(JSON.stringify(exported)).not.toContain('owner@example.test');
    });

    it('logs aborted requests once and never as completed', async () => {
      gate = { entered: deferred(), release: deferred(), done: deferred() };
      const controller = new AbortController();
      const pending = call(id('aborted'), 'observability-test/slow', {
        signal: controller.signal,
      }).catch((error: unknown) => error);
      await gate.entered.promise;
      controller.abort();
      expect(await pending).toMatchObject({ name: 'AbortError' });
      await waitFor(() => completions(id('aborted')).length > 0, 'aborted log');
      gate.release.resolve();
      await gate.done.promise;
      // The next request's completion orders after any late write attempt.
      await call(id('after-abort'), 'observability-test/echo');
      await waitFor(
        () => completions(id('after-abort')).length > 0,
        'next log',
      );
      expect(completions(id('aborted'))).toEqual([
        expect.objectContaining({
          level: 'warn',
          message: 'http.request.aborted',
          route: '/api/v1/observability-test/slow',
        }),
      ]);
      expect(completions(id('aborted'))[0]).not.toHaveProperty('statusCode');
      await flushTelemetry();
      const aborted = spans
        .getFinishedSpans()
        .map(spanView)
        .filter((span) => span.name === 'GET /api/v1/observability-test/slow');
      expect(aborted).toHaveLength(1);
      expect(aborted[0].attributes).toEqual({
        'http.request.method': 'GET',
        'http.route': '/api/v1/observability-test/slow',
        'error.type': 'aborted',
      });
    });

    it('keeps successful health probes out of logs, spans and metrics', async () => {
      for (const path of ['health/live', 'health/ready'])
        expect((await call(id('probe'), path)).status).toBe(200);
      expect(logsFor(id('probe'))).toEqual([]);
      await call(id('probed-then'), 'observability-test/echo');
      await flushTelemetry();
      expect(spans.getFinishedSpans().map((span) => span.name)).toEqual([
        'GET /api/v1/observability-test/echo',
      ]);
      const points = await metrics.histogram('http.server.request.duration');
      expect(points.map((point) => point.attributes['http.route'])).toEqual([
        '/api/v1/observability-test/echo',
      ]);
    });

    it('records one bounded duration histogram per route template and status', async () => {
      for (let index = 0; index < 3; index++)
        await call(
          id(`metric-${index}`),
          `observability-test/fail/${crypto.randomUUID()}`,
        );
      await call(id('metric-ok'), 'observability-test/echo');
      await call(id('metric-missing'), `missing/${RAW_ID}`);
      const points = await metrics.histogram('http.server.request.duration');
      const byRoute = Object.fromEntries(
        points.map((point) => [
          `${String(point.attributes['http.route'])} ${String(point.attributes['http.response.status_code'])}`,
          point,
        ]),
      );
      expect(Object.keys(byRoute).sort()).toEqual([
        '/api/v1/observability-test/echo 200',
        '/api/v1/observability-test/fail/:id 500',
        'undefined 404',
      ]);
      expect(
        byRoute['/api/v1/observability-test/fail/:id 500'].value.count,
      ).toBe(3);
      expect(
        byRoute['/api/v1/observability-test/fail/:id 500'].attributes[
          'error.type'
        ],
      ).toBe('500');
      for (const point of points) {
        expect(
          Object.keys(point.attributes).every((key) =>
            SPAN_ATTRIBUTES.has(key),
          ),
        ).toBe(true);
        expect(point.value.sum).toBeLessThan(10);
      }
      expect(JSON.stringify(points)).not.toContain(RAW_ID);
    });

    it('flushes once, stops exporting after shutdown and tolerates repeated shutdown calls', async () => {
      await call(id('before-shutdown'), 'observability-test/echo');
      let shutdowns = 0;
      const original = spans.shutdown.bind(spans);
      spans.shutdown = () => {
        shutdowns++;
        return original();
      };
      await Promise.all([shutdownTelemetry(), shutdownTelemetry()]);
      expect(spans.getFinishedSpans()).toHaveLength(0);
      expect(activeTracer()).toBeUndefined();
      expect(trace.getActiveSpan()).toBeUndefined();
      const response = await call(
        id('after-shutdown'),
        `observability-test/fail/${RAW_ID}`,
      );
      expect(response.status).toBe(500);
      await app!.close();
      app = undefined;
      await shutdownTelemetry();
      expect(shutdowns).toBe(1);
      expect(sentry.events()).toHaveLength(0);
    });
  });

  it('runs without spans, trace IDs or exporter connections when telemetry is disabled', async () => {
    const connections: Socket[] = [];
    const collector = createServer((socket) => connections.push(socket));
    const port = await listen(collector);
    try {
      await start({
        OTEL_ENABLED: 'false',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
      });
      expect(activeTracer()).toBeUndefined();
      const response = await fetch(
        `${url}/api/v1/observability-test/fail/${RAW_ID}`,
        {
          headers: { traceparent: `00-${'2'.repeat(32)}-${'3'.repeat(16)}-01` },
        },
      );
      expect(response.status).toBe(500);
      expect(response.headers.get('x-request-id')).toMatch(UUID);
      await flushTelemetry();
      await stop();
      const requestId = response.headers.get('x-request-id')!;
      expect(logsFor(requestId).map((record) => record.message)).toEqual([
        'http.request.failed',
        'http.request.completed',
      ]);
      for (const record of logger.records)
        expect(record).not.toHaveProperty('traceId');
      expect(connections).toHaveLength(0);
    } finally {
      collector.close();
    }
  });

  it('exports nothing at sampling ratio 0, even for inbound sampled parents, while metrics continue', async () => {
    const spans = new InMemorySpanExporter();
    const metrics = new TestMetricReader();
    await start(
      { ...baseTelemetry, SENTRY_DSN: '', OTEL_TRACES_SAMPLER_ARG: '0' },
      { spanExporter: spans, metricReader: metrics },
    );
    await fetch(`${url}/api/v1/observability-test/echo`);
    await fetch(`${url}/api/v1/observability-test/echo`, {
      headers: { traceparent: `00-${'4'.repeat(32)}-${'5'.repeat(16)}-01` },
    });
    await flushTelemetry();
    expect(spans.getFinishedSpans()).toHaveLength(0);
    const [point] = await metrics.histogram('http.server.request.duration');
    expect(point.value.count).toBe(2);
  });

  it.each([
    ['refusing', false],
    ['never responding', true],
  ])(
    'keeps serving and shuts down within the deadline when the collector is %s',
    async (_label, accept) => {
      const sockets: Socket[] = [];
      const collector = createServer((socket) => sockets.push(socket));
      const port = await listen(collector);
      if (!accept) await new Promise((resolve) => collector.close(resolve));
      try {
        await start({
          ...baseTelemetry,
          SENTRY_DSN: '',
          OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
          OTEL_EXPORTER_OTLP_HEADERS:
            'authorization=Bearer%20collector-secret-91c2',
          OTEL_METRIC_EXPORT_INTERVAL: '5000',
        });
        for (let index = 0; index < 3; index++)
          expect(
            (await fetch(`${url}/api/v1/observability-test/echo`)).status,
          ).toBe(200);
        const flushStarted = Date.now();
        await flushTelemetry();
        const startedAt = Date.now();
        await shutdownTelemetry();
        expect(startedAt - flushStarted).toBeLessThan(4_000);
        expect(Date.now() - startedAt).toBeLessThan(2_500);
        expect(
          (await fetch(`${url}/api/v1/observability-test/echo`)).status,
        ).toBe(200);
        const warnings = logger.records.filter(
          (record) => record.message === 'telemetry.export.failed',
        );
        expect(warnings.length).toBeLessThanOrEqual(1);
        expect(warnings.every((record) => record.level === 'warn')).toBe(true);
        const text = JSON.stringify(logger.records);
        expect(text).not.toContain('collector-secret-91c2');
        expect(text).not.toContain(`127.0.0.1:${port}`);
      } finally {
        for (const socket of sockets) socket.destroy();
        if (accept) collector.close();
      }
    },
  );
});
