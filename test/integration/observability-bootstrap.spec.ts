import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { authEnvironment } from '../helpers/auth-environment.js';
import { startTestDatabase } from '../helpers/postgres.js';

const main = fileURLToPath(new URL('../../src/main.js', import.meta.url));

interface Received {
  path: string;
  authorization?: string;
  body: string;
}

interface OtlpAttribute {
  key: string;
  value: Record<string, unknown>;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  attributes: OtlpAttribute[];
  scope: string;
}

async function freePort() {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function spansOf(received: Received[]): OtlpSpan[] {
  return received
    .filter((item) => item.path === '/v1/traces')
    .flatMap((item) => {
      const payload = JSON.parse(item.body) as {
        resourceSpans: {
          scopeSpans: {
            scope: { name: string };
            spans: Omit<OtlpSpan, 'scope'>[];
          }[];
        }[];
      };
      return payload.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) =>
          scope.spans.map((span) => ({ ...span, scope: scope.scope.name })),
        ),
      );
    });
}

const attribute = (span: OtlpSpan, key: string) =>
  span.attributes.find((item) => item.key === key)?.value;

describe('Production bootstrap with OpenTelemetry (compiled ESM main.js)', () => {
  let container: StartedPostgreSqlContainer;
  let collector: Server;
  let child: ChildProcess | undefined;
  const received: Received[] = [];
  let stdout = '';
  let stderr = '';
  let cwd: string;

  beforeAll(async () => {
    container = await startTestDatabase();
    collector = createServer((request, response) => {
      void readBody(request).then((body) => {
        received.push({
          path: request.url ?? '',
          authorization: request.headers.authorization,
          body,
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) =>
      collector.listen(0, '127.0.0.1', resolve),
    );
    cwd = mkdtempSync(join(tmpdir(), 'nest-pr12-bootstrap-'));
  });
  afterAll(async () => {
    child?.kill('SIGKILL');
    collector?.close();
    rmSync(cwd, { recursive: true, force: true });
    await container?.stop();
  });

  it('instruments pg after early startup, continues W3C context, exports once on SIGTERM and leaks nothing', async () => {
    const port = await freePort();
    const collectorUrl = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
    const databaseUrl = container.getConnectionUri();
    child = spawn(process.execPath, [main], {
      cwd,
      env: {
        NODE_ENV: 'development',
        PORT: String(port),
        DATABASE_URL: databaseUrl,
        ...authEnvironment,
        OTEL_ENABLED: 'true',
        OTEL_SERVICE_NAME: 'bootstrap-test',
        OTEL_EXPORTER_OTLP_ENDPOINT: collectorUrl,
        OTEL_EXPORTER_OTLP_HEADERS:
          'authorization=Bearer%20collector-secret-5d1e',
        OTEL_TRACES_SAMPLER_ARG: '1',
        OTEL_METRIC_EXPORT_INTERVAL: '300000',
        // Sentry enabled against the same receiver: it must send nothing
        // without errors and must not add spans, hooks or a tracer.
        SENTRY_DSN: `${collectorUrl.replace('://', '://public@')}/1`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = once(child, 'exit') as Promise<
      [number | null, NodeJS.Signals | null]
    >;

    const base = `http://127.0.0.1:${port}/api/v1`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      const ready = await fetch(`${base}/health/ready`).catch(() => undefined);
      if (ready?.status === 200) break;
      if (Date.now() > deadline || child.exitCode !== null)
        throw new Error(`API did not become ready:\n${stdout}\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const parentId = 'b7ad6b7169203331';
    const requestId = 'bootstrap-request-0001';
    const credentials = {
      email: 'bootstrap@example.test',
      password: 'bootstrap pass phrase 5d1e',
    };
    const registered = await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: authEnvironment.AUTH_TRUSTED_ORIGINS,
        traceparent: `00-${traceId}-${parentId}-01`,
        'X-Request-ID': requestId,
      },
      body: JSON.stringify(credentials),
    });
    expect(registered.status).toBe(201);
    expect(registered.headers.get('x-request-id')).toBe(requestId);
    const { accessToken } = (await registered.json()) as {
      accessToken: string;
    };
    const refreshCookie = registered.headers.get('set-cookie')!.split(';')[0];
    const me = await fetch(`${base}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(me.status).toBe(200);
    expect(received.filter((item) => item.path === '/v1/metrics')).toHaveLength(
      0,
    );

    const stopStarted = Date.now();
    child.kill('SIGTERM');
    const [code, signal] = await exited;
    expect(Date.now() - stopStarted).toBeLessThan(20_000);
    expect(code === 0 || signal === 'SIGTERM').toBe(true);

    const spans = spansOf(received);
    const server = spans.filter(
      (span) => span.scope === 'ultra-nest-template.http',
    );
    const register = server.find(
      (span) => span.name === 'POST /api/v1/auth/register',
    )!;
    expect(register).toMatchObject({
      traceId,
      parentSpanId: parentId,
      kind: 2,
    });
    expect(server.map((span) => span.name).sort()).toEqual([
      'GET /api/v1/users/me',
      'POST /api/v1/auth/register',
    ]);

    const pg = spans.filter(
      (span) => span.scope === '@opentelemetry/instrumentation-pg',
    );
    const serverIds = new Set(server.map((span) => span.spanId));
    expect(pg.length).toBeGreaterThan(0);
    expect(
      pg.some(
        (span) =>
          span.traceId === traceId && span.parentSpanId === register.spanId,
      ),
    ).toBe(true);
    for (const span of pg) {
      expect(serverIds.has(span.parentSpanId!)).toBe(true);
      expect(attribute(span, 'db.system.name')).toEqual({
        stringValue: 'postgresql',
      });
      expect(typeof attribute(span, 'db.query.text')?.stringValue).toBe(
        'string',
      );
    }
    for (const span of spans)
      for (const { key } of span.attributes) {
        expect(key.startsWith('drizzle.')).toBe(false);
        expect(key).not.toMatch(
          /parameter|db\.user|connection_string|url\.|client\.|user_agent/,
        );
      }
    expect(new Set(spans.map((span) => span.scope))).toEqual(
      new Set([
        'ultra-nest-template.http',
        '@opentelemetry/instrumentation-pg',
      ]),
    );

    const metrics = received.filter((item) => item.path === '/v1/metrics');
    expect(metrics).toHaveLength(1);
    expect(metrics[0].body).toContain('http.server.request.duration');
    expect(metrics[0].body).not.toContain('/health/');
    for (const item of received.filter((entry) =>
      entry.path.startsWith('/v1/'),
    ))
      expect(item.authorization).toBe('Bearer collector-secret-5d1e');
    expect(received.filter((item) => !item.path.startsWith('/v1/'))).toEqual(
      [],
    );

    const records = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.every((record) => record.service === 'bootstrap-test')).toBe(
      true,
    );
    expect(
      records.find(
        (record) =>
          record.requestId === requestId &&
          record.message === 'http.request.completed',
      ),
    ).toMatchObject({
      traceId,
      spanId: register.spanId,
      route: '/api/v1/auth/register',
      statusCode: 201,
    });

    const everything = [
      stdout,
      stderr,
      ...received.map((item) => item.body),
    ].join('\n');
    const databasePassword = new URL(databaseUrl).password;
    for (const leaked of [
      credentials.email,
      credentials.password,
      accessToken,
      refreshCookie.split('=')[1],
      databasePassword,
      'collector-secret-5d1e',
      authEnvironment.AUTH_SIGNING_KEY,
    ])
      expect({ leaked, found: everything.includes(leaked) }).toEqual({
        leaked,
        found: false,
      });
  });
});
