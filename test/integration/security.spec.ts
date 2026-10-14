import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { ApplicationConfig } from '@nestjs/core';
import { getDrizzleToken } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Database } from '../../src/database/database.module.js';
import { users } from '../../src/database/schema/index.js';
import { startTestDatabase } from '../helpers/postgres.js';
import { createAuthApp } from '../helpers/auth-app.js';
import { authEnvironment } from '../helpers/auth-environment.js';

// Undo the helper's generous unrelated-suite limits to exercise real defaults.
const defaults = {
  RATE_LIMIT_GLOBAL_LIMIT: '100',
  RATE_LIMIT_GLOBAL_TTL_MS: '60000',
  RATE_LIMIT_AUTH_LIMIT: '5',
  RATE_LIMIT_AUTH_TTL_MS: '60000',
  RATE_LIMIT_AUTH_BLOCK_MS: '300000',
  RATE_LIMIT_ACCOUNT_LIMIT: '3',
  RATE_LIMIT_ACCOUNT_TTL_MS: '60000',
  REQUEST_BODY_LIMIT_BYTES: '2048',
  TRUST_PROXY: 'false',
};
const credentials = {
  email: 'security@example.test',
  password: 'security test password phrase',
};
const origin = authEnvironment.AUTH_TRUSTED_ORIGINS;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function expectPolicies(response: Response, policies: string[]) {
  for (const name of ['global', 'auth', 'account']) {
    for (const header of ['limit', 'remaining', 'reset']) {
      const value = response.headers.get(`x-ratelimit-${header}-${name}`);
      if (policies.includes(name)) expect(value).not.toBeNull();
      else expect(value).toBeNull();
    }
  }
}

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
  const start = async (env: Record<string, string> = {}) => {
    await app?.close();
    app = await createAuthApp(
      container.getConnectionUri(),
      () => Date.now(),
      logger,
      origin,
      [],
      { ...defaults, ...env },
    );
    url = await app.getUrl();
    db = app.get<Database>(getDrizzleToken());
  };
  beforeAll(async () => {
    container = await startTestDatabase();
  });
  beforeEach(async () => {
    // Fresh application/storage for every test; no waits to clear prior buckets.
    await start();
    await db.delete(users);
    logs.length = 0;
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
      headers: { 'Content-Type': 'application/json', Origin: origin, ...extra },
      body: rawBody ?? JSON.stringify(body),
    });
  const register = (email = credentials.email) =>
    post('auth/register', { email, password: credentials.password });
  const bearer = async (email = credentials.email) => {
    const created = await register(email);
    expect(created.status).toBe(201);
    return ((await created.json()) as { accessToken: string }).accessToken;
  };
  const mutate = (
    path: string,
    token: string,
    body: unknown = {},
    method = 'PATCH',
    extra: Record<string, string> = {},
  ) =>
    fetch(`${url}/api/v1/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        Authorization: `Bearer ${token}`,
        ...extra,
      },
      body: JSON.stringify(body),
    });
  const passwordAttempt = (token: string, extra: Record<string, string> = {}) =>
    mutate(
      'users/me/password',
      token,
      {
        currentPassword: 'wrong current password',
        newPassword: 'replacement password phrase',
      },
      'PATCH',
      extra,
    );

  it('runs IP throttling before authentication and authorization', () => {
    expect(
      app
        .get(ApplicationConfig)
        .getGlobalGuards()
        .map((guard) => guard.constructor.name),
    ).toEqual(['ThrottlerGuard', 'AuthenticationGuard', 'AuthorizationGuard']);
  });

  it('serves only global headers on public routes', async () => {
    const response = await fetch(`${url}/api/v1`);
    expect(response.status).toBe(200);
    expectPolicies(response, ['global']);
    expect(response.headers.get('x-ratelimit-limit-global')).toBe('100');
    expect(response.headers.get('x-ratelimit-remaining-global')).toBe('99');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('strict-transport-security')).toContain(
      'max-age=',
    );
  });

  it('allows four consecutive /users/me reads under production defaults', async () => {
    const token = await bearer();
    for (let i = 0; i < 4; i++) {
      const response = await fetch(`${url}/api/v1/users/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expectPolicies(response, ['global']);
      expect(response.headers.get('x-ratelimit-limit-global')).toBe('100');
      expect(response.headers.get('x-ratelimit-remaining-global')).toBe(
        String(99 - i),
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it.each(['users/me', 'auth-test-protected'])(
    'enforces global only on %s, including routes without throttle annotations',
    async (path) => {
      await start({ RATE_LIMIT_GLOBAL_LIMIT: '7' });
      const token = await bearer();
      for (let i = 0; i < 7; i++) {
        const response = await fetch(`${url}/api/v1/${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(200);
        expectPolicies(response, ['global']);
        expect(response.headers.get('x-ratelimit-remaining-global')).toBe(
          String(6 - i),
        );
      }
      const blocked = await fetch(`${url}/api/v1/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('retry-after-global')).not.toBeNull();
      expect(blocked.headers.get('retry-after-auth')).toBeNull();
      expect(blocked.headers.get('retry-after-account')).toBeNull();
    },
  );

  it.each(['different', 'same', 'existing'])(
    'exhausts the per-IP auth budget after five attempts with %s emails',
    async (kind) => {
      if (kind === 'existing') await bearer();
      for (let i = 0; i < 6; i++) {
        const email =
          kind === 'existing'
            ? credentials.email
            : kind === 'same'
              ? 'missing@example.test'
              : `rotating-${i}@example.test`;
        const response = await post('auth/login', {
          email,
          password: 'wrong login password',
        });
        expect(response.status).toBe(i < 5 ? 401 : 429);
        if (i < 5) {
          expectPolicies(response, ['global', 'auth']);
          expect(response.headers.get('x-ratelimit-limit-auth')).toBe('5');
          expect(response.headers.get('x-ratelimit-remaining-auth')).toBe(
            String(4 - i),
          );
        } else {
          expect(response.headers.get('retry-after-auth')).not.toBeNull();
          const body = await response.text();
          expect(body).toContain('Too Many Requests');
          expect(body).not.toContain(email);
          expect(body).not.toContain('wrong login password');
        }
      }
      expect(logs.join('\n')).not.toContain('wrong login password');
      expect(logs.join('\n')).not.toContain('@example.test');
    },
  );

  it('throttles registration before password hashing and does not echo secrets', async () => {
    for (let i = 0; i < 6; i++) {
      const response = await register(`registration-${i}@example.test`);
      expect(response.status).toBe(i < 5 ? 201 : 429);
      if (i < 5) expectPolicies(response, ['global', 'auth']);
      else {
        expect(response.headers.get('retry-after-auth')).not.toBeNull();
        expect(await response.text()).not.toContain(credentials.password);
      }
    }
    expect(logs.join('\n')).not.toContain(credentials.password);
  });

  it('resets the auth budget after its configured block expires', async () => {
    await start({
      RATE_LIMIT_AUTH_LIMIT: '1',
      RATE_LIMIT_AUTH_TTL_MS: '1000',
      RATE_LIMIT_AUTH_BLOCK_MS: '1000',
    });
    const input = {
      email: 'reset@example.test',
      password: 'reset attempt password',
    };
    expect((await post('auth/login', input)).status).toBe(401);
    const blocked = await post('auth/login', input);
    expect(blocked.status).toBe(429);
    // Only the expiry test waits, using the server's advertised block duration.
    await wait(Number(blocked.headers.get('retry-after-auth')) * 1000 + 100);
    expect((await post('auth/login', input)).status).toBe(401);
  });

  it.each(['auth/refresh', 'auth/logout'])(
    'applies global + auth only to %s',
    async (path) => {
      const response = await post(path);
      expect(response.status).toBe(path.endsWith('refresh') ? 401 : 204);
      expectPolicies(response, ['global', 'auth']);
    },
  );

  it('applies only global to session administration and ordinary account mutations', async () => {
    const token = await bearer();
    const responses = [
      await fetch(`${url}/api/v1/auth/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      await mutate(
        'auth/sessions/11111111-1111-4111-8111-111111111111',
        token,
        {},
        'DELETE',
      ),
      await mutate('auth/logout-all', token, {}, 'POST'),
      await mutate('users/me', token, { displayName: 'Scope Test' }),
      await mutate('users/me', token, {}, 'DELETE'),
    ];
    expect(responses.map((response) => response.status)).toEqual([
      200, 204, 204, 200, 204,
    ]);
    for (const response of responses) expectPolicies(response, ['global']);
  });

  it('shares the account IP budget across authenticated users, without trusting body or bearer identity', async () => {
    const tokenA = await bearer('user-a@example.test');
    const tokenB = await bearer('user-b@example.test');
    for (const [index, token] of [tokenA, tokenB, tokenA].entries()) {
      const response = await passwordAttempt(token);
      expect(response.status).toBe(400);
      expectPolicies(response, ['global', 'account']);
      expect(response.headers.get('x-ratelimit-limit-account')).toBe('3');
      expect(response.headers.get('x-ratelimit-remaining-account')).toBe(
        String(2 - index),
      );
    }
    for (const token of [tokenA, tokenB, 'unverified.jwt.claims']) {
      const blocked = await mutate('users/me/password', token, {
        id: 'different-user',
        userId: 'different-user',
        email: 'changed@example.test',
      });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('retry-after-account')).not.toBeNull();
    }
    // An exhausted mutation bucket does not throttle the read handler.
    const read = await fetch(`${url}/api/v1/users/me`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(read.status).toBe(200);
    expectPolicies(read, ['global']);
  });

  it('applies account only to admin mutations, sharing a handler bucket across target IDs', async () => {
    const token = await bearer();
    await db
      .update(users)
      .set({ role: 'admin' })
      .where(eq(users.email, credentials.email));
    for (const path of [
      'users',
      'users/11111111-1111-4111-8111-111111111111',
    ]) {
      const read = await fetch(`${url}/api/v1/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(read.status).toBe(path === 'users' ? 200 : 404);
      expectPolicies(read, ['global']);
    }
    for (const method of ['PATCH', 'DELETE']) {
      for (let i = 1; i <= 4; i++) {
        const response = await mutate(
          `users/11111111-1111-4111-8111-11111111111${i}`,
          token,
          method === 'PATCH' ? { displayName: 'Admin update' } : {},
          method,
        );
        expect(response.status).toBe(i <= 3 ? 404 : 429);
        if (i <= 3) expectPolicies(response, ['global', 'account']);
        else expect(response.headers.get('retry-after-account')).not.toBeNull();
      }
    }
  });

  it.each(['false', '192.0.2.0/24'])(
    'ignores spoofed/invalid headers when socket peer is untrusted (%s)',
    async (trustProxy) => {
      await start({ TRUST_PROXY: trustProxy });
      for (let i = 0; i < 6; i++) {
        const response = await post(
          'auth/login',
          {
            email: `spoof-${i}@example.test`,
            password: 'spoof attempt password',
          },
          {
            'X-Forwarded-For':
              i % 2 ? `203.0.113.${i}, 198.51.100.2` : `invalid-${i}`,
            Forwarded: `for=203.0.113.${i}`,
            'X-Real-IP': `203.0.113.${i}`,
          },
        );
        expect(response.status).toBe(i < 5 ? 401 : 429);
      }
    },
  );

  it('accepts selected trusted-ingress IPs, rejects invalid identities and stops at the nearest untrusted hop', async () => {
    await start({ TRUST_PROXY: 'loopback' });
    for (let i = 0; i < 5; i++) {
      const response = await post(
        'auth/login',
        {
          email: `trusted-${i}@example.test`,
          password: 'proxy attempt password',
        },
        { 'X-Forwarded-For': `203.0.113.${i}, 198.51.100.7` },
      );
      expect(response.status).toBe(401);
    }
    expect(
      (
        await post('auth/login', credentials, {
          'X-Forwarded-For': '203.0.113.99, 198.51.100.7',
        })
      ).status,
    ).toBe(429);
    expect(
      (
        await post('auth/login', credentials, {
          'X-Forwarded-For': '198.51.100.8',
        })
      ).status,
    ).toBe(401);
    for (const invalid of [
      'garbage',
      '999.1.1.1',
      '198.51.100.7:1234',
      'unknown',
    ]) {
      const response = await post('auth/login', credentials, {
        'X-Forwarded-For': invalid,
      });
      expect(response.status).toBe(400);
      expectPolicies(response, []);
      expect(await response.text()).not.toContain(invalid);
    }
  });

  it('isolates account budgets by validated IP, not by authenticated user', async () => {
    await start({ TRUST_PROXY: 'loopback' });
    const token = await bearer();
    for (let i = 0; i < 4; i++) {
      expect(
        (await passwordAttempt(token, { 'X-Forwarded-For': '198.51.100.7' }))
          .status,
      ).toBe(i < 3 ? 400 : 429);
    }
    const otherIp = await passwordAttempt(token, {
      'X-Forwarded-For': '198.51.100.8',
    });
    expect(otherIp.status).toBe(400);
    expect(otherIp.headers.get('x-ratelimit-remaining-account')).toBe('2');
  });

  it('preserves native IPv6 subnet normalization for auth budgets', async () => {
    await start({ TRUST_PROXY: 'loopback' });
    for (let i = 1; i <= 6; i++) {
      expect(
        (
          await post('auth/login', credentials, {
            'X-Forwarded-For': `2001:db8:1::${i}`,
          })
        ).status,
      ).toBe(i <= 5 ? 401 : 429);
    }
    expect(
      (
        await post('auth/login', credentials, {
          'X-Forwarded-For': '2001:db8:2::1',
        })
      ).status,
    ).toBe(401);
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
