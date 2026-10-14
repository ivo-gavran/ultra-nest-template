import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { JwtSigner, TokenService } from '@nestjs/authentication';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import type { Database } from '../../src/database/database.module.js';
import {
  users,
  authTokenFamilies as families,
  authRefreshTokens as tokens,
  authRevokedFamilies as revoked,
} from '../../src/database/schema/index.js';
import { sessionPageSchema } from '../../src/modules/auth/schemas/session.schema.js';
import { startTestDatabase } from '../helpers/postgres.js';
import { createAuthApp } from '../helpers/auth-app.js';
import { authEnvironment } from '../helpers/auth-environment.js';

const input = {
  email: 'sessions@example.test',
  password: 'test password phrase',
};
const foreignInput = { ...input, email: 'other@example.test' };
const cookie = (response: Response) =>
  response.headers.get('set-cookie')!.split(';')[0];
const access = async (response: Response) =>
  ((await response.json()) as { accessToken: string }).accessToken;

describe('Session administration with real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let db: Database;
  let url: string;
  let now: number;
  const logs: string[] = [];
  const record = (...values: unknown[]) => {
    logs.push(JSON.stringify(values));
  };
  const logger: LoggerService = {
    log: record,
    error: record,
    warn: record,
    debug: record,
    verbose: record,
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
    await db.delete(revoked);
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await container?.stop();
    }
  });

  const request = (
    path: string,
    method = 'GET',
    bearer = '',
    body?: unknown,
    refresh = '',
    origin: string | null = authEnvironment.AUTH_TRUSTED_ORIGINS,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${url}/api/v1/auth/${path}`, {
      method,
      headers: {
        ...(origin === null ? {} : { Origin: origin }),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(refresh ? { Cookie: refresh } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const signIn = async (path = 'register', credentials = input) => {
    const response = await request(path, 'POST', '', credentials);
    expect(response.status).toBe(path === 'register' ? 201 : 200);
    return { access: await access(response), cookie: cookie(response) };
  };
  const page = async (bearer: string, query = '') => {
    const response = await request(`sessions${query}`, 'GET', bearer);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return sessionPageSchema.parse(await response.json());
  };
  const refresh = (value: string) => request('refresh', 'POST', '', {}, value);
  const expectDeletion = (response: Response) => {
    for (const flag of [
      '__Host-refresh=;',
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Path=/',
      'Expires=Thu, 01 Jan 1970',
    ])
      expect(response.headers.get('set-cookie')).toContain(flag);
    expect(response.headers.get('set-cookie')).not.toContain('Domain=');
  };

  it('lists only owned public sessions and uses the verified sid, preserving it through rotation', async () => {
    const first = await signIn();
    const second = await signIn('login');
    const foreign = await signIn('register', foreignInput);
    const own = await page(first.access);
    expect(own.items).toHaveLength(2);
    expect(own.items.every((item) => item.status === 'active')).toBe(true);
    expect(own.items.filter((item) => item.current)).toHaveLength(1);
    const current = own.items.find((item) => item.current)!;
    const other = (await page(second.access)).items.find(
      (item) => item.current,
    )!;
    expect(current.id).not.toBe(other.id);
    expect((await page(foreign.access)).items).toHaveLength(1);
    const rotated = await refresh(first.cookie);
    expect(rotated.status).toBe(200);
    expect(
      (await page(await access(rotated))).items.find((item) => item.current)
        ?.id,
    ).toBe(current.id);
    // A cookie for another login cannot override the verified bearer identity.
    const response = await request(
      'sessions',
      'GET',
      first.access,
      undefined,
      foreign.cookie,
    );
    expect(
      sessionPageSchema
        .parse(await response.json())
        .items.find((item) => item.current)?.id,
    ).toBe(current.id);
    await request(`sessions/${other.id}`, 'DELETE', first.access);
    const serialized =
      JSON.stringify(await page(first.access)) + logs.join('\n');
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, input.email));
    for (const value of [
      first.access,
      second.access,
      first.cookie.split('=')[1],
      input.email,
      input.password,
      user.passwordHash,
      ...(await db.select().from(families)).map((row) => row.familyId),
      ...(await db.select().from(tokens)).map((row) => row.id),
    ])
      expect(serialized.includes(value)).toBe(false);
    expect(
      logs.filter((line) => line.includes('auth.session.revoked')),
    ).toHaveLength(1);
    expect(Object.keys(current).sort()).toEqual([
      'createdAt',
      'current',
      'expiresAt',
      'id',
      'status',
    ]);
  });

  it('distinguishes revoked, expired family, expired token, spent-only and empty families', async () => {
    const first = await signIn();
    for (let i = 0; i < 5; i++) await signIn('login');
    const rows = await db.select().from(families);
    await db.insert(revoked).values({ familyId: rows[0].familyId });
    await db
      .update(families)
      .set({ familyExpiresAt: new Date(0) })
      .where(eq(families.familyId, rows[0].familyId));
    await db
      .update(families)
      .set({ familyExpiresAt: new Date(0) })
      .where(eq(families.familyId, rows[1].familyId));
    await db
      .update(tokens)
      .set({ expiresAt: new Date(0) })
      .where(eq(tokens.familyId, rows[2].familyId));
    await db
      .update(tokens)
      .set({ usedAt: new Date() })
      .where(eq(tokens.familyId, rows[3].familyId));
    await db.delete(tokens).where(eq(tokens.familyId, rows[4].familyId));
    const listed = await page(first.access);
    for (const [index, status] of [
      'revoked',
      'expired',
      'expired',
      'expired',
      'expired',
      'active',
    ].entries())
      expect(
        listed.items.find((item) => item.id === rows[index].sessionId)?.status,
      ).toBe(status);
  });

  it('paginates by timestamp and UUID without duplicates when a newer login arrives', async () => {
    const first = await signIn();
    for (let i = 0; i < 4; i++) await signIn('login');
    // Real issuances share the injected millisecond clock, exercising the tie-breaker.
    const all = await page(first.access);
    expect(all.items.map((item) => item.id)).toEqual(
      all.items
        .map((item) => item.id)
        .sort()
        .reverse(),
    );
    const firstPage = await page(first.access, '?limit=2');
    now += 1000;
    await signIn('login');
    const secondPage = await page(
      first.access,
      `?limit=2&after=${firstPage.nextCursor!}`,
    );
    const lastPage = await page(
      first.access,
      `?limit=2&after=${secondPage.nextCursor!}`,
    );
    expect([
      ...firstPage.items,
      ...secondPage.items,
      ...lastPage.items,
    ]).toEqual(all.items);
    expect(lastPage.nextCursor).toBeNull();
    expect(
      await page(first.access, `?limit=2&after=${firstPage.nextCursor!}`),
    ).toEqual(secondPage);
    const foreign = await signIn('register', foreignInput);
    const foreignId = (await page(foreign.access)).items[0].id;
    for (const id of [foreignId, randomUUID()])
      expect(await page(first.access, `?after=${id}`)).toEqual({
        items: [],
        nextCursor: null,
      });
  });

  it('atomically revokes an owned session, keeps successors/tokens and survives restart', async () => {
    const first = await signIn();
    const other = await signIn('login');
    const current = (await page(first.access)).items.find(
      (item) => item.current,
    )!;
    const rotated = await refresh(first.cookie);
    expect(rotated.status).toBe(200);
    const successor = cookie(rotated);
    const before = await db.select().from(tokens);
    for (let i = 0; i < 2; i++) {
      const response = await request(
        `sessions/${current.id.toUpperCase()}`,
        'DELETE',
        first.access,
        undefined,
        successor,
      );
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expectDeletion(response);
    }
    expect(await db.select().from(tokens)).toEqual(before);
    expect(
      logs.filter((line) => line.includes('auth.session.revoked')),
    ).toHaveLength(1);
    await app.close();
    await start();
    expect((await refresh(successor)).status).toBe(401);
    expect((await refresh(first.cookie)).status).toBe(401);
    expect((await refresh(other.cookie)).status).toBe(200);
    expect(
      (await page(first.access)).items.find((item) => item.id === current.id),
    ).toMatchObject({ status: 'revoked', current: true });
  });

  it.each([
    ['A', 'A', true],
    ['B', 'A', false],
    ['B', 'B', true],
  ] as const)(
    'bearer A + cookie %s revoking %s clears cookie: %s',
    async (cookieSession, targetSession, clears) => {
      const a = await signIn();
      const b = await signIn('login');
      const idA = (await page(a.access)).items.find((item) => item.current)!.id;
      const idB = (await page(b.access)).items.find((item) => item.current)!.id;
      const response = await request(
        `sessions/${targetSession === 'A' ? idA : idB}`,
        'DELETE',
        a.access,
        undefined,
        cookieSession === 'A' ? a.cookie : b.cookie,
      );
      expect(response.status).toBe(204);
      if (clears) expectDeletion(response);
      else expect(response.headers.get('set-cookie')).toBeNull();
      expect(
        (await refresh(targetSession === 'A' ? a.cookie : b.cookie)).status,
      ).toBe(401);
      expect(
        (await refresh(targetSession === 'A' ? b.cookie : a.cookie)).status,
      ).toBe(200);
    },
  );

  it.each(['missing', 'invalid', 'unknown', 'overlong', 'foreign'] as const)(
    'preserves %s cookies while revoking an owned session',
    async (kind) => {
      const a = await signIn();
      const foreign = await signIn('register', foreignInput);
      const id = (await page(a.access)).items[0].id;
      const values = {
        missing: '',
        invalid: '__Host-refresh=invalid',
        unknown: `__Host-refresh=${randomBytes(32).toString('base64url')}`,
        overlong: `__Host-refresh=${'x'.repeat(129)}`,
        foreign: foreign.cookie,
      };
      const response = await request(
        `sessions/${id}`,
        'DELETE',
        a.access,
        undefined,
        values[kind],
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect((await refresh(a.cookie)).status).toBe(401);
      expect((await refresh(foreign.cookie)).status).toBe(200);
    },
  );

  it('does not clear a foreign-user cookie even when it matches the targeted session', async () => {
    const a = await signIn();
    const foreign = await signIn('register', foreignInput);
    const id = (await page(foreign.access)).items[0].id;
    for (const target of [id, randomUUID()]) {
      const response = await request(
        `sessions/${target}`,
        'DELETE',
        a.access,
        undefined,
        foreign.cookie,
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect(await db.select().from(revoked)).toHaveLength(0);
    expect((await refresh(a.cookie)).status).toBe(200);
    expect((await refresh(foreign.cookie)).status).toBe(200);
  });

  it('clears a persisted spent cookie without consuming or deleting refresh records', async () => {
    const a = await signIn();
    const id = (await page(a.access)).items[0].id;
    const rotated = await refresh(a.cookie);
    expect(rotated.status).toBe(200);
    const before = await db.select().from(tokens);
    const response = await request(
      `sessions/${id}`,
      'DELETE',
      a.access,
      undefined,
      a.cookie,
    );
    expect(response.status).toBe(204);
    expectDeletion(response);
    expect(await db.select().from(tokens)).toEqual(before);
    expect((await refresh(cookie(rotated))).status).toBe(401);
  });

  it('makes foreign, unknown, repeated and own non-current revocation indistinguishable', async () => {
    const first = await signIn();
    const second = await signIn('login');
    const otherId = (await page(second.access)).items.find(
      (item) => item.current,
    )!.id;
    const foreign = await signIn('register', foreignInput);
    const foreignId = (await page(foreign.access)).items[0].id;
    for (const id of [foreignId, randomUUID(), otherId, otherId]) {
      const response = await request(`sessions/${id}`, 'DELETE', first.access);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect((await refresh(foreign.cookie)).status).toBe(200);
    expect((await refresh(second.cookie)).status).toBe(401);
    expect((await refresh(first.cookie)).status).toBe(200);
    expect(await db.select().from(revoked)).toHaveLength(1);
  });

  it('logout-all revokes every existing device, persists after restart, isolates users and allows new login', async () => {
    const first = await signIn();
    const second = await signIn('login');
    const foreign = await signIn('register', foreignInput);
    const response = await request('logout-all', 'POST', first.access, {});
    expect(response.status).toBe(204);
    expectDeletion(response);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await app.close();
    await start();
    for (const value of [first.cookie, second.cookie])
      expect((await refresh(value)).status).toBe(401);
    expect(
      (await page(first.access)).items.every(
        (item) => item.status === 'revoked',
      ),
    ).toBe(true);
    expect((await refresh(foreign.cookie)).status).toBe(200);
    const newLogin = await signIn('login');
    expect((await refresh(newLogin.cookie)).status).toBe(200);
    now += 900000;
    expect((await request('sessions', 'GET', first.access)).status).toBe(401);
  });

  it.each([
    'sessions',
    'logout-all',
    'sessions/00000000-0000-4000-8000-000000000001',
  ])(
    'requires verified bearer credentials for %s, including after account deletion',
    async (path) => {
      const first = await signIn();
      const method =
        path === 'sessions' ? 'GET' : path === 'logout-all' ? 'POST' : 'DELETE';
      const [user] = await db.select().from(users);
      const forged = new JwtSigner({
        key: randomBytes(32),
        type: 'at+jwt',
      }).sign({ sub: user.id, sid: randomUUID() });
      for (const bearer of ['', 'invalid', forged]) {
        const response = await request(path, method, bearer);
        expect(response.status).toBe(401);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
      await db.delete(users);
      expect((await request(path, method, first.access)).status).toBe(401);
      expect(await db.select().from(families)).toHaveLength(0);
      expect(await db.select().from(tokens)).toHaveLength(0);
    },
  );

  it.each([
    '?limit=0',
    '?limit=101',
    '?limit=1.2',
    '?limit=abc',
    '?limit=2&limit=3',
    '?after=invalid',
    '?userId=forbidden',
    '?sid=forbidden',
  ])('rejects invalid or extra pagination fields: %s', async (query) => {
    const first = await signIn();
    const response = await request(`sessions${query}`, 'GET', first.access);
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('validates UUIDs and rejects user/session identity in logout-all bodies', async () => {
    const first = await signIn();
    expect(
      (await request('sessions/not-a-uuid', 'DELETE', first.access)).status,
    ).toBe(400);
    for (const body of [
      { userId: randomUUID() },
      { sid: randomUUID() },
      { role: 'admin' },
    ])
      expect(
        (await request('logout-all', 'POST', first.access, body)).status,
      ).toBe(400);
    expect((await refresh(first.cookie)).status).toBe(200);
  });

  it.each([
    null,
    'null',
    'https://evil.test',
    'https://app.example.test.evil.test',
  ])('denies cookie mutations for Origin=%s', async (origin) => {
    const first = await signIn();
    const id = (await page(first.access)).items[0].id;
    for (const [path, method] of [
      [`sessions/${id}`, 'DELETE'],
      ['logout-all', 'POST'],
    ]) {
      const response = await request(
        path,
        method,
        first.access,
        undefined,
        first.cookie,
        origin,
        { 'Sec-Fetch-Site': 'cross-site' },
      );
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect((await refresh(first.cookie)).status).toBe(200);
  });

  it('supports trusted DELETE preflight and bearer-only GET without an Origin', async () => {
    const first = await signIn();
    const response = await request(
      `sessions/${randomUUID()}`,
      'OPTIONS',
      '',
      undefined,
      '',
      undefined,
      {
        'Access-Control-Request-Method': 'DELETE',
        'Access-Control-Request-Headers': 'authorization',
      },
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain(
      'DELETE',
    );
    expect(response.headers.get('access-control-allow-credentials')).toBe(
      'true',
    );
    expect(response.headers.get('access-control-allow-origin')).toBe(
      authEnvironment.AUTH_TRUSTED_ORIGINS,
    );
    expect(
      (await request('sessions', 'GET', first.access, undefined, '', null))
        .status,
    ).toBe(200);
  });

  it('does not pretend storage failures succeeded or clear retryable cookies', async () => {
    const first = await signIn();
    const id = (await page(first.access)).items[0].id;
    // Real storage failure, no mocked service or query. Restore even on assertion failure.
    await db.$client.query(
      'alter table auth_revoked_families rename to unavailable_revocations',
    );
    try {
      for (const [path, method] of [
        ['sessions', 'GET'],
        [`sessions/${id}`, 'DELETE'],
        ['logout-all', 'POST'],
      ]) {
        const response = await request(path, method, first.access);
        expect(response.status).toBe(503);
        expect(response.headers.get('set-cookie')).toBeNull();
        expect(await response.json()).toMatchObject({
          message: 'Authentication temporarily unavailable',
        });
      }
    } finally {
      await db.$client.query(
        'alter table unavailable_revocations rename to auth_revoked_families',
      );
    }
    expect(logs.join('\n')).not.toContain('auth_revoked_families');
    expect((await refresh(first.cookie)).status).toBe(200);
  });

  it('handles supported signed tokens without sid without inventing current identity', async () => {
    await signIn();
    const [user] = await db.select().from(users);
    const pair = await app.get(TokenService).issue(user.id);
    expect(
      (await page(pair.accessToken)).items.every((item) => !item.current),
    ).toBe(true);
  });

  async function waitForLocks(count: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await db.$client.query<{ count: string }>(
        "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%users%'",
      );
      if (Number(result.rows[0].count) >= count) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error('Expected user-row lock was not observed');
  }

  it('keeps a successor saved after targeted revocation unusable', async () => {
    const first = await signIn();
    const id = (await page(first.access)).items[0].id;
    const [user] = await db.select().from(users);
    const blocker = await db.$client.connect();
    let rotation!: Promise<Response>;
    try {
      await blocker.query('begin');
      await blocker.query('select id from users where id=$1 for update', [
        user.id,
      ]);
      rotation = refresh(first.cookie);
      await waitForLocks(1);
      expect(
        (await request(`sessions/${id}`, 'DELETE', first.access)).status,
      ).toBe(204);
    } finally {
      await blocker.query('commit');
      blocker.release();
    }
    expect((await rotation).status).toBe(401);
    expect(await db.select().from(tokens)).toHaveLength(2);
    expect((await refresh(first.cookie)).status).toBe(401);
    expect((await page(first.access)).items[0].status).toBe('revoked');
  });

  it.each(['login', 'refresh'] as const)(
    'serializes HTTP logout-all against concurrent %s in both lock orders',
    async (operation) => {
      for (const revokeFirst of [false, true]) {
        const first = await signIn(
          (await db.select().from(users)).length ? 'login' : 'register',
        );
        const [user] = await db.select().from(users);
        const blocker = await db.$client.connect();
        let issuance!: Promise<Response>;
        let logout!: Promise<Response>;
        const issue = () =>
          operation === 'login'
            ? request('login', 'POST', '', input)
            : refresh(first.cookie);
        const revoke = () => request('logout-all', 'POST', first.access);
        try {
          await blocker.query('begin');
          await blocker.query('select id from users where id=$1 for update', [
            user.id,
          ]);
          if (revokeFirst) logout = revoke();
          else issuance = issue();
          await waitForLocks(1);
          if (revokeFirst) issuance = issue();
          else logout = revoke();
          await waitForLocks(2);
        } finally {
          await blocker.query('commit');
          blocker.release();
        }
        const [issued, revokedResponse] = await Promise.all([issuance, logout]);
        expect(revokedResponse.status).toBe(204);
        expectDeletion(revokedResponse);
        const survives = operation === 'login' && revokeFirst;
        if (survives) expect(issued.status).toBe(200);
        else expect([200, 401]).toContain(issued.status);
        if (issued.status === 200)
          expect((await refresh(cookie(issued))).status).toBe(
            survives ? 200 : 401,
          );
        expect((await refresh(first.cookie)).status).toBe(401);
        const sessions = await page(first.access);
        expect(
          sessions.items.filter((item) => item.status === 'active'),
        ).toHaveLength(survives ? 1 : 0);
      }
    },
  );
});
