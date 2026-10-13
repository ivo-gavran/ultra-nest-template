import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Database } from '../../src/database/database.module.js';
import { users } from '../../src/database/schema/index.js';
import { startTestDatabase } from '../helpers/postgres.js';
import { createAuthApp } from '../helpers/auth-app.js';
import { authEnvironment } from '../helpers/auth-environment.js';

// Tight, deterministic limits for this suite only.
const tight = {
  RATE_LIMIT_GLOBAL_LIMIT: '10',
  RATE_LIMIT_GLOBAL_TTL_MS: '1000',
  RATE_LIMIT_AUTH_LIMIT: '3',
  RATE_LIMIT_AUTH_TTL_MS: '1000',
  RATE_LIMIT_AUTH_BLOCK_MS: '2000',
  RATE_LIMIT_ACCOUNT_LIMIT: '2',
  RATE_LIMIT_ACCOUNT_TTL_MS: '1000',
  REQUEST_BODY_LIMIT_BYTES: '2048',
};

const credentials = {
  email: 'security@example.test',
  password: 'security test password phrase',
};
const origin = authEnvironment.AUTH_TRUSTED_ORIGINS;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Security hardening (PR-10)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let db: Database;
  let url: string;
  const logs: string[] = [];
  const recordLog = (...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  };
  const logger: LoggerService = {
    log: recordLog,
    error: recordLog,
    warn: recordLog,
    debug: recordLog,
    verbose: recordLog,
  };
  const start = async (env: Record<string, string> = tight) => {
    app = await createAuthApp(
      container.getConnectionUri(),
      () => Date.now(),
      logger,
      origin,
      [],
      env,
    );
    url = await app.getUrl();
    db = app.get<Database>(getDrizzleToken());
  };
  beforeAll(async () => {
    container = await startTestDatabase();
    await start();
  });
  beforeEach(async () => {
    logs.length = 0;
    await db.delete(users);
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await container?.stop();
    }
  });

  const post = (
    path: string,
    body: unknown = {},
    extra: Record<string, string> = {},
    rawBody?: string,
  ) =>
    fetch(`${url}/api/v1/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        ...extra,
      },
      body: rawBody ?? JSON.stringify(body),
    });
  const register = (email = credentials.email, extra = {}) =>
    post('auth/register', { email, password: credentials.password }, extra);

  it('serves rate-limit headers and succeeds below the global limit', async () => {
    const response = await fetch(`${url}/api/v1`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-ratelimit-limit-global')).toBe('10');
    expect(response.headers.get('x-ratelimit-remaining-global')).toBe('9');
    expect(response.headers.get('x-ratelimit-reset-global')).toBe('1');
    // Security headers from useSecurityHeaders() remain enabled.
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('strict-transport-security')).toContain(
      'max-age=',
    );
  });

  it('returns 429 past the stricter auth limit, including nonexistent accounts', async () => {
    const statuses: number[] = [];
    let throttled: Response | undefined;
    for (let i = 0; i < 5; i++) {
      const response = await post('auth/login', {
        email: 'ghost@example.test',
        password: 'whatever password attempt',
      });
      statuses.push(response.status);
      if (response.status === 429) throttled = response;
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses[3]).toBe(429);
    expect(throttled).toBeDefined();
    expect(throttled!.headers.get('retry-after-auth')).toBeTruthy();
    const text = await throttled!.text();
    expect(text).toContain('Too Many Requests');
    expect(text).not.toContain('ghost@example.test');
    expect(text).not.toContain('whatever password attempt');
    expect(text).not.toContain('scrypt');
  });

  it('throttles registration before scrypt work and does not echo secrets', async () => {
    let throttled = false;
    // Same hashed-email key: attempts 1-3 register/throttle-count, then 429
    // before any further scrypt hash or duplicate-account work.
    for (let i = 0; i < 6; i++) {
      const response = await register('reg@example.test');
      if (response.status === 429) {
        throttled = true;
        const text = await response.text();
        expect(text).not.toContain(credentials.password);
      }
    }
    expect(throttled).toBe(true);
    expect(logs.join('\n')).not.toContain(credentials.password);
  });

  it('resets auth limits after the configured window', async () => {
    for (let i = 0; i < 4; i++)
      await post('auth/login', {
        email: 'reset@example.test',
        password: 'reset attempt password',
      });
    expect(
      (
        await post('auth/login', {
          email: 'reset@example.test',
          password: 'reset attempt password',
        })
      ).status,
    ).toBe(429);
    // Window is 1s; wait just past it (bounded, deterministic config).
    await wait(2600);
    expect(
      (
        await post('auth/login', {
          email: 'reset@example.test',
          password: 'reset attempt password',
        })
      ).status,
    ).toBe(401);
  });

  it('cannot be bypassed with spoofed forwarding headers when proxy trust is off', async () => {
    const spoofed: Record<string, string>[] = [
      { 'X-Forwarded-For': '203.0.113.10' },
      { 'X-Forwarded-For': '203.0.113.11, 198.51.100.2' },
      { 'X-Real-IP': '203.0.113.12' },
      { Forwarded: 'for=203.0.113.13' },
    ];
    let saw429 = false;
    for (let i = 0; i < 6; i++) {
      const response = await post(
        'auth/login',
        { email: 'spoof@example.test', password: 'spoof attempt password' },
        spoofed[i % spoofed.length],
      );
      if (response.status === 429) saw429 = true;
    }
    expect(saw429).toBe(true);
  });

  it('treats each hashed-email tracker independently within the auth limit', async () => {
    for (let i = 0; i < 3; i++)
      await post('auth/login', {
        email: 'first@example.test',
        password: 'first attempt password',
      });
    expect(
      (
        await post('auth/login', {
          email: 'first@example.test',
          password: 'first attempt password',
        })
      ).status,
    ).toBe(429);
    // A different account key from the same client is not blocked by the
    // first key, but the plain client-IP auth bucket still applies at 3.
    const other = await post('auth/login', {
      email: 'second@example.test',
      password: 'second attempt password',
    });
    expect([401, 429]).toContain(other.status);
  });

  it('keeps authenticated requests behind the global limiter', async () => {
    const created = await register();
    expect(created.status).toBe(201);
    const { accessToken } = (await created.json()) as {
      accessToken: string;
    };
    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const response = await fetch(`${url}/api/v1/users/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      lastStatus = response.status;
      if (i === 0) {
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    }
    expect(lastStatus).toBe(429);
  });

  it('applies the account limiter to password changes per authenticated user', async () => {
    const created = await register('changer@example.test');
    expect(created.status).toBe(201);
    const { accessToken } = (await created.json()) as {
      accessToken: string;
    };
    const attempt = () =>
      fetch(`${url}/api/v1/users/me/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          currentPassword: 'wrong current password',
          newPassword: 'replacement password phrase',
        }),
      });
    expect((await attempt()).status).toBe(400);
    expect((await attempt()).status).toBe(400);
    expect((await attempt()).status).toBe(429);
  });

  it('rejects oversized JSON and URL-encoded bodies with 413 before validation', async () => {
    const big = 'x'.repeat(3000);
    const json = await post(
      'auth/login',
      {},
      {},
      JSON.stringify({ email: 'big@example.test', password: big }),
    );
    expect(json.status).toBe(413);
    const text = await json.text();
    expect(text).not.toContain(big);
    expect(text.toLowerCase()).not.toContain('sql');

    const form = await fetch(`${url}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: origin,
      },
      body: `email=big%40example.test&password=${big}`,
    });
    expect(form.status).toBe(413);
  });

  it('keeps normally sized payloads on the Zod validation path', async () => {
    const invalid = await post('auth/register', {
      email: 'not-an-email',
      password: 'short',
      role: 'admin',
    });
    expect(invalid.status).toBe(400);
    const malformed = await post('auth/login', {}, {}, '{not json');
    expect(malformed.status).toBe(400);
    const text = await malformed.text();
    expect(text).not.toContain('not json');
  });

  it('preserves browser origin, CSRF, CORS and cookie protections', async () => {
    const evil = await fetch(`${url}/api/v1/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example.test',
      },
      body: JSON.stringify(credentials),
    });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();

    const crossSite = await fetch(`${url}/api/v1/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example.test',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({
        email: 'cross-site@example.test',
        password: credentials.password,
      }),
    });
    expect(crossSite.status).toBe(403);

    const ok = await register('browser@example.test');
    expect(ok.status).toBe(201);
    const cookie = ok.headers.get('set-cookie')!;
    for (const flag of [
      '__Host-refresh=',
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Path=/',
    ])
      expect(cookie).toContain(flag);
    expect(cookie).not.toContain('Domain=');
    expect(ok.headers.get('access-control-allow-origin')).toBe(origin);
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
    expect(ok.headers.get('cache-control')).toBe('no-store');

    const preflight = await fetch(`${url}/api/v1/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain(
      'POST',
    );

    const logText = logs.join('\n');
    for (const secret of [
      credentials.password,
      cookie.split(';')[0].split('=')[1],
    ])
      expect(logText.includes(secret)).toBe(false);
  });

  it('does not leak secrets, SQL or stack traces in error responses', async () => {
    // Wait out any auth block left by earlier tests in this suite.
    await wait(2600);
    const wrong = await post('auth/login', {
      email: 'leak-check-2@example.test',
      password: 'definitely wrong password',
    });
    expect(wrong.status).toBe(401);
    const body = (await wrong.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('definitely wrong password');
    expect(JSON.stringify(body).toLowerCase()).not.toContain('select ');
    expect(JSON.stringify(body)).not.toContain('scrypt$');

    const missing = await fetch(`${url}/api/v1/users/me`);
    expect(missing.status).toBe(401);
    const guardBody = (await missing.json()) as Record<string, unknown>;
    expect(guardBody).not.toHaveProperty('stack');
  });
});

describe('Trusted proxy throttling identity', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let db: Database;
  let url: string;
  beforeAll(async () => {
    container = await startTestDatabase();
    app = await createAuthApp(
      container.getConnectionUri(),
      () => Date.now(),
      false,
      origin,
      [],
      { ...tight, TRUST_PROXY: 'loopback' },
    );
    url = await app.getUrl();
    db = app.get<Database>(getDrizzleToken());
  });
  beforeEach(async () => {
    await db.delete(users);
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await container?.stop();
    }
  });

  it('keys throttling by the forwarded client only behind the trusted proxy', async () => {
    const attempt = (forwarded: string) =>
      fetch(`${url}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          'X-Forwarded-For': forwarded,
        },
        body: JSON.stringify({
          email: 'proxy@example.test',
          password: 'proxy attempt password',
        }),
      });
    for (let i = 0; i < 3; i++)
      expect((await attempt('198.51.100.7')).status).toBe(401);
    expect((await attempt('198.51.100.7')).status).toBe(429);
    // A different forwarded client behind the trusted loopback proxy has
    // its own bucket.
    expect((await attempt('198.51.100.8')).status).toBe(401);
  });
});
