import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { Controller, Get } from '@nestjs/common';
import type { BeforeApplicationShutdown } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { InjectDrizzle, getDrizzleToken } from '@nestjs/drizzle';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Database } from '../../src/database/database.module.js';
import type { PublicUser } from '../../src/modules/users/schemas/user.schema.js';
import { z } from 'zod';
import { userPageSchema } from '../../src/modules/users/schemas/user.schema.js';
type UserPage = z.infer<typeof userPageSchema>;
import type { SessionPage } from '../../src/modules/auth/schemas/session.schema.js';
import { createReleaseApp } from '../helpers/release-app.js';
import { startTestDatabase } from '../helpers/postgres.js';
import { authEnvironment } from '../helpers/auth-environment.js';
import { deferred } from '../helpers/deferred.js';

// Only this test module can expose these routes. The failure is a real pg
// error; the barrier controls lifecycle ordering without replacing providers.
@Controller('release-fixture')
class ReleaseFixture implements BeforeApplicationShutdown {
  readonly entered = deferred<void>();
  readonly finish = deferred<void>();
  readonly draining = deferred<void>();
  readonly continueShutdown = deferred<void>();
  holdShutdown = false;
  constructor(@InjectDrizzle() private readonly db: Database) {}

  @Get('failure')
  @Public()
  async failure() {
    await this.db.$client.query("select 'private-sql-sentinel'::integer");
  }

  @Get('work')
  @Public()
  async work() {
    this.entered.resolve();
    await this.finish.promise;
    await this.db.$client.query('SELECT 1');
    return { completed: true };
  }

  // Deliberately missing @Can/@Public to verify production deny-by-default.
  @Get('undeclared')
  undeclared() {
    return { forbidden: true };
  }

  async beforeApplicationShutdown() {
    if (!this.holdShutdown) return;
    this.draining.resolve();
    await this.continueShutdown.promise;
  }
}

const origin = authEnvironment.AUTH_TRUSTED_ORIGINS;
const credentials = (label: string) => ({
  email: `${label}@example.test`,
  password: 'release synthetic password phrase',
});
const cookieOf = (response: Response) =>
  response.headers.get('set-cookie')!.split(';')[0];
function expectCookie(response: Response, cleared = false) {
  const cookie = response.headers.get('set-cookie')!;
  for (const flag of [
    '__Host-refresh=',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
  ])
    expect(cookie).toContain(flag);
  expect(cookie).not.toContain('Domain=');
  if (cleared) expect(cookie).toContain('Expires=Thu, 01 Jan 1970');
}
interface Login {
  accessToken: string;
  expiresIn: number;
}
interface RequestOptions {
  method?: string;
  access?: string;
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

describe('Release candidate: production HTTP/security modules and migrated PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let server: Awaited<ReturnType<typeof createReleaseApp>>;
  let db: Database;
  let now: number;

  const request = (
    path: string,
    { method = 'GET', access, cookie, body, headers = {} }: RequestOptions = {},
  ) =>
    fetch(`${server.base}/${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(access ? { Authorization: `Bearer ${access}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
  const post = (path: string, body: unknown = {}, cookie?: string) =>
    request(path, { method: 'POST', body, cookie });
  async function register(label: string) {
    const response = await post('auth/register', credentials(label));
    expect(response.status).toBe(201);
    expectCookie(response);
    const login = (await response.json()) as Login;
    expect(Object.keys(login).sort()).toEqual(['accessToken', 'expiresIn']);
    expect(login.expiresIn).toBe(900);
    return { access: login.accessToken, cookie: cookieOf(response) };
  }
  async function restart(trustProxy?: string) {
    await server?.app.close();
    server = await createReleaseApp(container.getConnectionUri(), {
      controllers: [ReleaseFixture],
      now: () => now,
      trustProxy,
    });
    db = server.app.get<Database>(getDrizzleToken());
  }

  beforeAll(async () => {
    container = await startTestDatabase();
  });
  beforeEach(async () => {
    now = Date.now();
    await restart();
    await db.$client.query(
      'TRUNCATE users, auth_token_families, auth_refresh_tokens, auth_revoked_families CASCADE',
    );
  });
  afterEach(async () => {
    if (server) {
      const fixture = server.app.get(ReleaseFixture);
      fixture.finish.resolve();
      fixture.continueShutdown.resolve();
      await server.app.close();
    }
  });
  afterAll(async () => {
    await container?.stop();
  });

  it('registers, logs in, rotates, durably rejects replay across restart, logs out and enforces JWT expiration', async () => {
    const registered = await register('lifecycle');
    const login = await post('auth/login', credentials('lifecycle'));
    expect(login.status).toBe(200);
    const { accessToken } = (await login.json()) as Login;
    const first = cookieOf(login);
    expect((await request('users/me', { access: accessToken })).status).toBe(
      200,
    );
    expect((await request('users/me')).status).toBe(401);
    const rotated = await post('auth/refresh', {}, first);
    expect(rotated.status).toBe(200);
    expectCookie(rotated);
    const successor = cookieOf(rotated);
    expect(successor).not.toBe(first);
    expect((await post('auth/refresh', {}, first)).status).toBe(401);
    expect((await post('auth/refresh', {}, successor)).status).toBe(401);
    const tombstones = await db.$client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM auth_revoked_families',
    );
    expect(tombstones.rows[0].count).toBe(1);
    await restart();
    expect((await post('auth/refresh', {}, successor)).status).toBe(401);
    const logoutRevoked = await post('auth/logout', {}, successor);
    expect(logoutRevoked.status).toBe(204);
    expectCookie(logoutRevoked, true);
    const logout = await post('auth/logout', {}, registered.cookie);
    expect(logout.status).toBe(204);
    expectCookie(logout, true);
    expect((await post('auth/refresh', {}, registered.cookie)).status).toBe(
      401,
    );
    expect((await post('auth/logout', {}, registered.cookie)).status).toBe(204);
    expect((await request('users/me', { access: accessToken })).status).toBe(
      200,
    );
    now += 901000; // Public package clock; no waiting and unchanged 15m TTL.
    expect((await request('users/me', { access: accessToken })).status).toBe(
      401,
    );
  });

  it('isolates owners, rejects mass assignment, paginates admin search and reloads database roles with the same JWT', async () => {
    const admin = await register('admin');
    const alice = await register('alice');
    const bob = await register('bob');
    const profile = await request('users/me', alice);
    expect(profile.status).toBe(200);
    expect(profile.headers.get('cache-control')).toBe('no-store');
    const user = (await profile.json()) as PublicUser;
    expect(Object.keys(user).sort()).toEqual([
      'createdAt',
      'displayName',
      'email',
      'id',
      'role',
      'updatedAt',
    ]);
    const bobUser = (await (
      await request('users/me', bob)
    ).json()) as PublicUser;
    for (const body of [
      { role: 'admin' },
      { id: bobUser.id },
      { passwordHash: 'forged' },
    ]) {
      expect(
        (await request('users/me', { ...alice, method: 'PATCH', body })).status,
      ).toBe(400);
    }
    const updated = await request('users/me', {
      ...alice,
      method: 'PATCH',
      body: { displayName: 'Release Alice' },
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as PublicUser).displayName).toBe(
      'Release Alice',
    );
    expect((await request(`users/${bobUser.id}`, alice)).status).toBe(403);
    expect((await request('users', alice)).status).toBe(403);
    expect((await request('release-fixture/undeclared', alice)).status).toBe(
      403,
    );
    const bobSessions = (await (
      await request('auth/sessions', bob)
    ).json()) as SessionPage;
    expect(
      (
        await request(`auth/sessions/${bobSessions.items[0].id}`, {
          ...alice,
          method: 'DELETE',
        })
      ).status,
    ).toBe(204);
    expect((await post('auth/refresh', {}, bob.cookie)).status).toBe(200);
    const ownSessions = (await (
      await request('auth/sessions', alice)
    ).json()) as SessionPage;
    expect(ownSessions.items).toHaveLength(1);
    expect(ownSessions.items[0].id).not.toBe(bobSessions.items[0].id);
    // Bootstrap the first administrator through the database, never a public input.
    await db.$client.query("UPDATE users SET role = 'admin' WHERE email = $1", [
      credentials('admin').email,
    ]);
    expect((await request('release-fixture/undeclared', admin)).status).toBe(
      403,
    );
    const first = await request(
      'users?search=example.test&sort=email&order=asc&limit=2',
      admin,
    );
    expect(first.status).toBe(200);
    const page = (await first.json()) as UserPage;
    expect(page.items.map((item) => item.email)).toEqual([
      'admin@example.test',
      'alice@example.test',
    ]);
    expect(page.nextCursor).toBeTruthy();
    const next = (await (
      await request(
        `users?search=example.test&sort=email&order=asc&limit=2&after=${page.nextCursor}`,
        admin,
      )
    ).json()) as UserPage;
    expect(next.items.map((item) => item.email)).toEqual(['bob@example.test']);
    expect(next.nextCursor).toBeNull();
    const search = (await (
      await request('users?search=Release%20Alice', admin)
    ).json()) as UserPage;
    expect(search.items.map((item) => item.id)).toEqual([user.id]);
    expect((await request(`users/${randomUUID()}`, admin)).status).toBe(404);
    expect(
      (
        await request(`users/${user.id}`, {
          ...admin,
          method: 'PATCH',
          body: { role: 'admin' },
        })
      ).status,
    ).toBe(200);
    expect((await request('users', alice)).status).toBe(200);
    expect(
      (
        await request(`users/${user.id}`, {
          ...admin,
          method: 'PATCH',
          body: { role: 'user' },
        })
      ).status,
    ).toBe(200);
    expect((await request('users', alice)).status).toBe(403);
  });

  it('changes a production-cost password, revokes other families and permanently deletes account credentials', async () => {
    const current = await register('password');
    const second = await post('auth/login', credentials('password'));
    expect(second.status).toBe(200);
    const other = cookieOf(second);
    const hashes = await db.$client.query<{ password_hash: string }>(
      'SELECT password_hash FROM users',
    );
    expect(
      hashes.rows[0].password_hash.startsWith('$scrypt$ln=17,r=8,p=1$'),
    ).toBe(true);
    const newPassword = 'replacement synthetic password phrase';
    const change = (currentPassword: string) =>
      request('users/me/password', {
        ...current,
        method: 'PATCH',
        body: { currentPassword, newPassword },
      });
    expect((await change('incorrect old password')).status).toBe(400);
    const changed = await change(credentials('password').password);
    expect(changed.status).toBe(204);
    expect(changed.headers.get('set-cookie')).toBeNull();
    expect((await post('auth/login', credentials('password'))).status).toBe(
      401,
    );
    const newLogin = await post('auth/login', {
      email: credentials('password').email,
      password: newPassword,
    });
    expect(newLogin.status).toBe(200);
    expect((await post('auth/refresh', {}, other)).status).toBe(401);
    const rotated = await post('auth/refresh', {}, current.cookie);
    expect(rotated.status).toBe(200);
    const successor = cookieOf(rotated);
    const deleted = await request('users/me', {
      ...current,
      method: 'DELETE',
      body: {},
    });
    expect(deleted.status).toBe(204);
    expectCookie(deleted, true);
    await restart();
    expect((await request('users/me', current)).status).toBe(401);
    expect(
      (
        await post('auth/login', {
          email: credentials('password').email,
          password: newPassword,
        })
      ).status,
    ).toBe(401);
    expect((await post('auth/refresh', {}, successor)).status).toBe(401);
    expect((await post('auth/refresh', {}, cookieOf(newLogin))).status).toBe(
      401,
    );
    for (const table of [
      'users',
      'auth_token_families',
      'auth_refresh_tokens',
    ]) {
      const result = await db.$client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table}`,
      );
      expect(result.rows[0].count).toBe(0);
    }
    expect(
      (await db.$client.query('SELECT 1 FROM auth_revoked_families')).rowCount,
    ).toBeGreaterThan(0);
  });

  it('enforces trusted Origins, native CSRF, credentialed CORS and secure cookie scope', async () => {
    for (const invalid of [
      '',
      'null',
      'https://evil.example.test',
      `${origin}.evil.test`,
    ]) {
      expect(
        (
          await request('auth/login', {
            method: 'POST',
            body: credentials('origin'),
            headers: { Origin: invalid },
          })
        ).status,
      ).toBe(403);
    }
    const missing = await fetch(`${server.base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials('origin')),
    });
    expect(missing.status).toBe(403);
    const crossSite = await request('greetings', {
      method: 'POST',
      body: { name: 'safe' },
      headers: {
        Origin: 'https://evil.example.test',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    expect(crossSite.status).toBe(403);
    for (const allowed of [true, false]) {
      const preflight = await request('auth/register', {
        method: 'OPTIONS',
        headers: {
          Origin: allowed ? origin : 'https://evil.example.test',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers':
            'content-type,authorization,x-request-id',
        },
      });
      expect(preflight.headers.get('access-control-allow-origin')).toBe(
        allowed ? origin : null,
      );
      if (allowed) {
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('access-control-allow-credentials')).toBe(
          'true',
        );
      }
    }
    const registered = await post('auth/register', credentials('cookies'));
    expect(registered.status).toBe(201);
    expectCookie(registered);
    expect(registered.headers.get('access-control-allow-origin')).toBe(origin);
    expect(registered.headers.get('access-control-allow-credentials')).toBe(
      'true',
    );
    expect(registered.headers.get('x-content-type-options')).toBe('nosniff');
    const json = (await registered.json()) as Login;
    expect(Object.keys(json).sort()).toEqual(['accessToken', 'expiresIn']);
    const logout = await post('auth/logout', {}, cookieOf(registered));
    expect(logout.status).toBe(204);
    expectCookie(logout, true);
  });

  it('covers 400/401/403/404/409/413/429/500 with correlation and sanitized responses/logs', async () => {
    const account = await register('errors');
    const cases: [number, string, RequestOptions][] = [
      [
        400,
        'users/me',
        { ...account, method: 'PATCH', body: { role: 'admin' } },
      ],
      [401, 'users/me', {}],
      [403, 'users', account],
      [404, 'missing', {}],
      [409, 'auth/register', { method: 'POST', body: credentials('errors') }],
      [
        413,
        'auth/login',
        { method: 'POST', body: { password: 'x'.repeat(20000) } },
      ],
      [500, 'release-fixture/failure', {}],
    ];
    for (const [status, path, options] of cases) {
      const id = `release-status-${status}-0001`;
      const response = await request(path, {
        ...options,
        headers: { 'X-Request-ID': id },
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('x-request-id')).toBe(id);
      const body = await response.text();
      expect(body).not.toMatch(
        /private-sql-sentinel|passwordHash|password_hash|\.ts:\d|\.js:\d|stack|SELECT|scrypt\$/i,
      );
      if (status === 500)
        expect(JSON.parse(body)).toEqual({
          statusCode: 500,
          message: 'Internal server error',
        });
    }
    // Real default auth budget is five, keyed to socket IP; spoofed forwarded
    // identities and different submitted accounts must not reset it.
    for (let i = 0; i < 6; i++) {
      const response = await request('auth/login', {
        method: 'POST',
        body: {
          email: `missing-${i}@example.test`,
          password: 'invalid credential phrase',
        },
        headers: {
          'X-Forwarded-For': `198.51.100.${i + 1}`,
          'X-Request-ID': `release-throttle-000${i}`,
        },
      });
      expect(response.status).toBe(i < 5 ? 401 : 429);
      if (i === 5) {
        expect(
          Number(response.headers.get('retry-after-auth')),
        ).toBeGreaterThan(0);
        expect(response.headers.get('x-request-id')).toBe(
          'release-throttle-0005',
        );
        expect(await response.json()).toMatchObject({
          statusCode: 429,
          message: 'Too Many Requests',
        });
      } else expect(response.headers.get('x-ratelimit-limit-auth')).toBe('5');
    }
    const invalidId = await request('health/live', {
      headers: { 'X-Request-ID': 'invalid id' },
    });
    expect(invalidId.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const logs = JSON.stringify(server.logger.records);
    for (const secret of [
      credentials('errors').email,
      credentials('errors').password,
      account.access,
      account.cookie.split('=')[1],
      'private-sql-sentinel',
      authEnvironment.AUTH_SIGNING_KEY,
    ])
      expect(logs.includes(secret)).toBe(false);
    const failures = server.logger.records.filter(
      (record) => record.message === 'http.request.failed',
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].requestId).toBe('release-status-500-0001');
  });

  it('validates trusted proxy identities and isolates real clients behind explicitly trusted ingress', async () => {
    await restart('loopback');
    const invalid = await request('auth/login', {
      method: 'POST',
      body: {},
      headers: { 'X-Forwarded-For': 'invalid-ip' },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      statusCode: 400,
      message: 'Bad Request',
    });
    for (let i = 0; i < 6; i++) {
      const blocked = await request('auth/login', {
        method: 'POST',
        body: {},
        headers: { 'X-Forwarded-For': '198.51.100.1' },
      });
      expect(blocked.status).toBe(i < 5 ? 400 : 429);
    }
    expect(
      (
        await request('auth/login', {
          method: 'POST',
          body: {},
          headers: { 'X-Forwarded-For': '198.51.100.2' },
        })
      ).status,
    ).toBe(400);
    // The nearest untrusted hop, not attacker-prepended entries, owns identity.
    expect(
      (
        await request('auth/login', {
          method: 'POST',
          body: {},
          headers: { 'X-Forwarded-For': '203.0.113.8, 198.51.100.1' },
        })
      ).status,
    ).toBe(429);
  });

  it('cannot expose the SQL privacy probe or Swagger in production even with the former flag enabled', async () => {
    expect(process.env.NODE_ENV).toBe('production');
    expect(process.env.OBSERVABILITY_SQL_PROBE).toBe('1');
    expect((await request('observability-sql-probe')).status).toBe(404);
    const root = server.base.replace('/api/v1', '');
    for (const path of [
      '/docs',
      '/docs-json',
      '/dist/main.js.map',
      '/main.js.map',
    ])
      expect((await fetch(`${root}${path}`)).status).toBe(404);
  });

  it('recovers readiness after a real database outage, drains in-flight work and closes the production pool', async () => {
    for (const route of ['live', 'ready'])
      expect((await request(`health/${route}`)).status).toBe(200);
    const outage = await container.exec([
      'psql',
      '-U',
      container.getUsername(),
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      "ALTER DATABASE starter_test ALLOW_CONNECTIONS false; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'starter_test';",
    ]);
    expect(outage.exitCode).toBe(0);
    try {
      expect((await request('health/live')).status).toBe(200);
      const ready = await request('health/ready');
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({
        status: 'error',
        info: {},
        error: { postgres: { status: 'down' } },
        details: { postgres: { status: 'down' } },
      });
    } finally {
      const restored = await container.exec([
        'psql',
        '-U',
        container.getUsername(),
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        'ALTER DATABASE starter_test ALLOW_CONNECTIONS true',
      ]);
      expect(restored.exitCode).toBe(0);
    }
    const deadline = Date.now() + 15000;
    while ((await request('health/ready')).status !== 200) {
      if (Date.now() > deadline) throw new Error('Database did not recover');
      await delay(50); // Condition polling only, never race synchronization.
    }
    const fixture = server.app.get(ReleaseFixture);
    const pool = db.$client;
    fixture.holdShutdown = true;
    const inFlight = request('release-fixture/work');
    await fixture.entered.promise;
    const closing = server.app.close();
    try {
      await fixture.draining.promise;
      expect(pool.ended).toBe(false);
      expect((await request('health/ready')).status).toBe(503);
      expect((await request('health/live')).status).toBe(200);
    } finally {
      fixture.continueShutdown.resolve();
      fixture.finish.resolve();
      expect((await inFlight).status).toBe(200);
      await closing;
    }
    expect(pool.ended).toBe(true);
    expect(pool.totalCount).toBe(0);
    await expect(pool.query('SELECT 1')).rejects.toThrow(/end/);
  });
});
