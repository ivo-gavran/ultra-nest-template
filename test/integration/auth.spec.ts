import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { JwtSigner, TokenService } from '@nestjs/authentication';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import type { Database } from '../../src/database/database.module.js';
import {
  users,
  authRefreshTokens,
  authTokenFamilies,
  authRevokedFamilies,
} from '../../src/database/schema/index.js';
import {
  PostgresRefreshTokenStore,
  AuthStorageError,
} from '../../src/modules/auth/storage/postgres-refresh-token.store.js';
import { startTestDatabase } from '../helpers/postgres.js';
import { createAuthApp } from '../helpers/auth-app.js';
import { authEnvironment } from '../helpers/auth-environment.js';

const input = {
  email: 'person@example.test',
  password: 'test password phrase',
};
type AccessResponse = { accessToken: string; expiresIn: number };
const readAccess = async (response: Response) =>
  (await response.json()) as AccessResponse;
const cookie = (response: Response) =>
  response.headers.get('set-cookie')!.split(';')[0];
const rawToken = (value: string) => value.slice(value.indexOf('=') + 1);
const digest = (value: string) =>
  createHash('sha256').update(value).digest('base64url');

describe('Browser authentication with real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let db: Database;
  let url: string;
  let now: number;
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
  const start = async () => {
    app = await createAuthApp(container.getConnectionUri(), () => now, logger);
    url = await app.getUrl();
    db = app.get<Database>(getDrizzleToken());
  };
  beforeAll(async () => {
    container = await startTestDatabase();
    now = Date.now();
    await start();
  });
  beforeEach(async () => {
    now = Date.now();
    logs.length = 0;
    await db.delete(users);
    await db.delete(authRevokedFamilies);
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
    value = '',
    origin: string | null = authEnvironment.AUTH_TRUSTED_ORIGINS,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${url}/api/v1/auth/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(origin === null ? {} : { Origin: origin }),
        ...(value ? { Cookie: value } : {}),
        ...extra,
      },
      body: JSON.stringify(body),
    });
  const protectedRequest = (access?: string) =>
    fetch(`${url}/api/v1/auth-test-protected`, {
      headers: access ? { Authorization: `Bearer ${access}` } : {},
    });

  it('registers only an ordinary user and exposes access credentials in the intended response fields', async () => {
    const response = await post('register', {
      ...input,
      email: ' Person@Example.test ',
      displayName: ' Example ',
    });
    expect(response.status).toBe(201);
    const payload = await readAccess(response);
    expect(Object.keys(payload).sort()).toEqual(['accessToken', 'expiresIn']);
    expect(payload.expiresIn).toBe(900);
    const [user] = await db.select().from(users);
    expect(user.email).toBe(input.email);
    expect(user.role).toBe('user');
    expect(user.passwordHash.startsWith('$scrypt$')).toBe(true);
    expect(JSON.stringify(payload).includes(user.passwordHash)).toBe(false);
    expect((await protectedRequest(payload.accessToken)).status).toBe(200);
    const refresh = rawToken(cookie(response));
    const [stored] = await db.select().from(authRefreshTokens);
    expect(stored.id === digest(refresh)).toBe(true);
    expect(JSON.stringify(stored).includes(refresh)).toBe(false);
    const logText = logs.join('\n');
    for (const sensitive of [
      input.password,
      input.email,
      user.passwordHash,
      refresh,
      payload.accessToken,
    ])
      expect(logText.includes(sensitive)).toBe(false);
  });

  it('sets scoped Secure/HttpOnly cookies and exact CORS/no-store headers with persisted expiration', async () => {
    const response = await post('register', input);
    const header = response.headers.get('set-cookie')!;
    for (const flag of [
      '__Host-refresh=',
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Path=/',
    ])
      expect(header.includes(flag)).toBe(true);
    expect(header.includes('Domain=')).toBe(false);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe(
      authEnvironment.AUTH_TRUSTED_ORIGINS,
    );
    expect(response.headers.get('access-control-allow-credentials')).toBe(
      'true',
    );
    const [stored] = await db.select().from(authRefreshTokens);
    const cookieExpiry = new Date(
      header.match(/Expires=([^;]+)/)![1],
    ).getTime();
    expect(cookieExpiry).toBeLessThanOrEqual(stored.expiresAt.getTime());
    expect(stored.expiresAt.getTime() - now).toBe(7 * 86400000);
  });

  it('logs in with normalized email and rejects wrong/absent credentials uniformly', async () => {
    await post('register', input);
    expect(
      (await post('login', { ...input, email: ' PERSON@EXAMPLE.TEST ' }))
        .status,
    ).toBe(200);
    const wrong = await post('login', { ...input, password: 'wrong password' });
    const absent = await post('login', {
      ...input,
      email: 'absent@example.test',
    });
    expect(wrong.status).toBe(401);
    expect(absent.status).toBe(401);
    expect(await wrong.json()).toEqual(await absent.json());
    expect(wrong.headers.get('set-cookie')).toBeNull();
  });

  it.each([
    ['register', { ...input, role: 'admin' }],
    ['register', { ...input, passwordHash: 'forbidden' }],
    ['register', { ...input, password: 'short' }],
    ['login', { ...input, sid: randomUUID() }],
    ['refresh', { refreshToken: 'forbidden' }],
    ['logout', { userId: randomUUID() }],
  ])('rejects invalid or mass-assignment input on %s', async (path, body) => {
    expect((await post(path, body)).status).toBe(400);
    expect(await db.select({ id: users.id }).from(users)).toHaveLength(0);
  });

  it('returns safe conflict for duplicate registration', async () => {
    await post('register', input);
    const response = await post('register', {
      ...input,
      email: input.email.toUpperCase(),
    });
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text.includes(input.email)).toBe(false);
    expect(text.includes('password')).toBe(false);
  });

  it.each([
    null,
    'null',
    'https://evil.example.test',
    'https://app.example.test.evil.test',
  ])('rejects browser mutations with Origin=%s', async (origin) => {
    for (const path of ['register', 'login', 'refresh', 'logout']) {
      const response = await post(
        path,
        path === 'register' || path === 'login' ? input : {},
        '',
        origin,
      );
      expect(response.status).toBe(403);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('enforces native CSRF checks and supports trusted credentialed preflight', async () => {
    expect(
      (
        await post('register', input, '', 'https://evil.test', {
          'Sec-Fetch-Site': 'cross-site',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          'register',
          input,
          '',
          authEnvironment.AUTH_TRUSTED_ORIGINS,
          { 'Sec-Fetch-Site': 'same-site' },
        )
      ).status,
    ).toBe(201);
    const preflight = await fetch(`${url}/api/v1/auth/refresh`, {
      method: 'OPTIONS',
      headers: {
        Origin: authEnvironment.AUTH_TRUSTED_ORIGINS,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-credentials')).toBe(
      'true',
    );
    expect(preflight.headers.get('access-control-allow-origin')).toBe(
      authEnvironment.AUTH_TRUSTED_ORIGINS,
    );
  });

  it('rejects missing, malformed, wrongly signed and expired JWTs; reloads current users', async () => {
    const response = await post('register', input);
    const access = await readAccess(response);
    expect((await protectedRequest()).status).toBe(401);
    expect((await protectedRequest('invalid')).status).toBe(401);
    const [user] = await db.select({ id: users.id }).from(users);
    const forged = new JwtSigner({ key: randomBytes(32), type: 'at+jwt' }).sign(
      { sub: user.id },
    );
    expect((await protectedRequest(forged)).status).toBe(401);
    expect((await protectedRequest(access.accessToken)).status).toBe(200);
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, user.id));
    expect(
      await (await protectedRequest(access.accessToken)).json(),
    ).toMatchObject({ role: 'admin' });
    now += 900000;
    expect((await protectedRequest(access.accessToken)).status).toBe(401);
  });

  it('rotates once, preserves sid and absolute deadline, then revokes successors on replay', async () => {
    const first = await post('register', input);
    const firstCookie = cookie(first);
    const [family] = await db.select().from(authTokenFamilies);
    now += 86400000;
    const next = await post('refresh', {}, firstCookie);
    expect(next.status).toBe(200);
    const nextCookie = cookie(next);
    expect(nextCookie === firstCookie).toBe(false);
    const records = await db.select().from(authRefreshTokens);
    expect(records).toHaveLength(2);
    expect(records.filter((record) => record.usedAt !== null)).toHaveLength(1);
    expect(
      records.every((record) => record.claims?.sid === family.sessionId),
    ).toBe(true);
    expect(
      records.every(
        (record) =>
          record.expiresAt.getTime() === family.familyExpiresAt.getTime(),
      ),
    ).toBe(true);
    const replay = await post('refresh', {}, firstCookie);
    expect(replay.status).toBe(401);
    expect(replay.headers.get('set-cookie')).toContain(
      'Expires=Thu, 01 Jan 1970',
    );
    expect((await post('refresh', {}, nextCookie)).status).toBe(401);
    // Refresh revocation does not retroactively revoke already issued access JWTs.
    const issued = await readAccess(next);
    expect((await protectedRequest(issued.accessToken)).status).toBe(200);
  });

  it('allows only one concurrent HTTP refresh and invalidates its successor after replay', async () => {
    const first = await post('register', input);
    const results = await Promise.all([
      post('refresh', {}, cookie(first)),
      post('refresh', {}, cookie(first)),
    ]);
    expect(
      results.every((response) => [200, 401].includes(response.status)),
    ).toBe(true);
    expect(
      results.filter((response) => response.status === 200).length,
    ).toBeLessThanOrEqual(1);
    const winner = results.find((response) => response.status === 200);
    if (winner)
      expect((await post('refresh', {}, cookie(winner))).status).toBe(401);
    const [family] = await db.select().from(authTokenFamilies);
    expect(
      await app
        .get(PostgresRefreshTokenStore)
        .isRefreshTokenFamilyRevoked(family.familyId),
    ).toBe(true);
  });

  it('persists logout revocation across a new application/pool and clears matching cookie scope', async () => {
    const first = await post('register', input);
    const value = cookie(first);
    const logout = await post('logout', {}, value);
    expect(logout.status).toBe(204);
    expect(await logout.text()).toBe('');
    for (const flag of [
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Path=/',
      'Expires=Thu, 01 Jan 1970',
    ])
      expect(logout.headers.get('set-cookie')).toContain(flag);
    expect(logout.headers.get('set-cookie')).not.toContain('Domain=');
    await app.close();
    await start();
    expect((await post('refresh', {}, value)).status).toBe(401);
    expect((await post('logout', {}, value)).status).toBe(204);
  });

  it('clears missing, malformed, unknown and expired refresh credentials with generic 401', async () => {
    const first = await post('register', input);
    now += 7 * 86400000;
    for (const value of [
      '',
      '__Host-refresh=invalid',
      `__Host-refresh=${randomBytes(32).toString('base64url')}`,
      cookie(first),
    ]) {
      const response = await post('refresh', {}, value);
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('set-cookie')).toContain(
        'Expires=Thu, 01 Jan 1970',
      );
      expect(await response.json()).toMatchObject({
        message: 'Invalid credentials',
      });
    }
    expect((await post('logout')).status).toBe(204);
  });

  it('accepts an omitted refresh body while taking credentials only from the cookie', async () => {
    const first = await post('register', input);
    const response = await fetch(`${url}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: {
        Origin: authEnvironment.AUTH_TRUSTED_ORIGINS,
        Cookie: cookie(first),
      },
    });
    expect(response.status).toBe(200);
  });

  it('rejects refresh and bearer credentials immediately after account deletion', async () => {
    const first = await post('register', input);
    const access = await readAccess(first);
    await db.delete(users);
    expect((await post('refresh', {}, cookie(first))).status).toBe(401);
    expect((await protectedRequest(access.accessToken)).status).toBe(401);
  });

  it('uses the durable store for TokenService.revokeAll without exposing an HTTP administration endpoint', async () => {
    const first = await post('register', input);
    const second = await post('login', input);
    const [user] = await db.select({ id: users.id }).from(users);
    await app.get(TokenService).revokeAll(user.id);
    expect((await post('refresh', {}, cookie(first))).status).toBe(401);
    expect((await post('refresh', {}, cookie(second))).status).toBe(401);
    expect((await post('logout-all')).status).toBe(404);
  });

  it('reports storage failures as 503 without clearing the cookie or claiming logout success', async () => {
    const first = await post('register', input);
    const value = cookie(first);
    const store = app.get(PostgresRefreshTokenStore);
    // Fault injection only; all normal auth and contract cases use real PostgreSQL.
    jest
      .spyOn(store, 'getRefreshToken')
      .mockRejectedValue(new AuthStorageError());
    for (const path of ['refresh', 'logout']) {
      const response = await post(path, {}, value);
      expect(response.status).toBe(503);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await response.json()).toMatchObject({
        message: 'Authentication temporarily unavailable',
      });
    }
    expect(logs.join('\n').includes(rawToken(value))).toBe(false);
  });
});
