import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { JwtSigner } from '@nestjs/authentication';
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
import { PasswordsService } from '../../src/modules/users/passwords.service.js';
import {
  publicUserResponseSchema,
  userPageSchema,
} from '../../src/modules/users/schemas/user.schema.js';
import { sessionPageSchema } from '../../src/modules/auth/schemas/session.schema.js';
import { PostgresRefreshTokenStore } from '../../src/modules/auth/storage/postgres-refresh-token.store.js';
import { createAuthApp } from '../helpers/auth-app.js';
import { startTestDatabase } from '../helpers/postgres.js';
import { authEnvironment } from '../helpers/auth-environment.js';

const input = {
  email: 'account@example.test',
  password: 'original password phrase',
};
const passwordChange = {
  currentPassword: input.password,
  newPassword: 'replacement password phrase',
};
const cookie = (response: Response) =>
  response.headers.get('set-cookie')!.split(';')[0];
type Login = { access: string; cookie: string };

describe('Users API and account lifecycle on pooled PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let db: Database;
  let url: string;
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
    app = await createAuthApp(container.getConnectionUri(), undefined, logger);
    db = app.get<Database>(getDrizzleToken());
    url = await app.getUrl();
  };
  beforeAll(async () => {
    container = await startTestDatabase();
    await start();
  });
  beforeEach(async () => {
    await db.delete(users);
    await db.delete(revoked);
    logs.length = 0;
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
    fetch(`${url}/api/v1/${path}`, {
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
  const signIn = async (
    path = 'register',
    credentials = input,
  ): Promise<Login> => {
    const response = await request(`auth/${path}`, 'POST', '', credentials);
    expect(response.status).toBe(path === 'register' ? 201 : 200);
    const body = (await response.json()) as { accessToken: string };
    return { access: body.accessToken, cookie: cookie(response) };
  };
  const profile = async (bearer: string) => {
    const response = await request('users/me', 'GET', bearer);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return publicUserResponseSchema.parse(await response.json());
  };
  const sessions = async (bearer: string) => {
    const response = await request('auth/sessions', 'GET', bearer);
    expect(response.status).toBe(200);
    return sessionPageSchema.parse(await response.json());
  };
  const refresh = (value: string) =>
    request('auth/refresh', 'POST', '', {}, value);
  const change = (bearer: string, body = passwordChange, refreshCookie = '') =>
    request('users/me/password', 'PATCH', bearer, body, refreshCookie);
  const admin = async () => {
    const login = await signIn('register', {
      ...input,
      email: 'admin@example.test',
    });
    const user = await profile(login.access);
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, user.id));
    return { ...login, id: user.id };
  };
  const list = async (bearer: string, query = '') => {
    const response = await request(`users${query}`, 'GET', bearer);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return userPageSchema.parse(await response.json());
  };
  const expectCookieDeletion = (response: Response) => {
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

  it('reads/updates only the verified profile, normalizes email, clears names and handles duplicate email', async () => {
    const own = await signIn();
    const other = await signIn('register', {
      ...input,
      email: 'other@example.test',
    });
    const before = await profile(own.access);
    const response = await request('users/me', 'PATCH', own.access, {
      email: ' CHANGED@Example.test ',
      displayName: ' New Name ',
    });
    expect(response.status).toBe(200);
    expect(publicUserResponseSchema.parse(await response.json())).toMatchObject(
      {
        id: before.id,
        email: 'changed@example.test',
        displayName: 'New Name',
        role: 'user',
      },
    );
    expect((await profile(other.access)).email).toBe('other@example.test');
    expect(
      (await request('users/me', 'PATCH', own.access, { displayName: null }))
        .status,
    ).toBe(200);
    const conflict = await request('users/me', 'PATCH', own.access, {
      email: 'OTHER@EXAMPLE.TEST',
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      message: 'Email is already in use',
    });
    expect((await profile(own.access)).email).toBe('changed@example.test');
  });

  it('rejects self-service mass assignment, delete identity and password verification bypass', async () => {
    const own = await signIn();
    const before = await profile(own.access);
    for (const key of [
      'role',
      'id',
      'userId',
      'passwordHash',
      'password_hash',
      'createdAt',
      'updatedAt',
      'extra',
    ]) {
      expect(
        (
          await request('users/me', 'PATCH', own.access, {
            displayName: 'attempt',
            [key]: 'admin',
          })
        ).status,
      ).toBe(400);
      expect(
        (await request('users/me', 'DELETE', own.access, { [key]: 'attempt' }))
          .status,
      ).toBe(400);
    }
    for (const body of [
      { newPassword: passwordChange.newPassword },
      { ...passwordChange, currentPassword: '' },
      { ...passwordChange, sid: randomUUID() },
      { ...passwordChange, userId: randomUUID() },
      { ...passwordChange, newPassword: 'short' },
    ])
      expect(
        (await request('users/me/password', 'PATCH', own.access, body)).status,
      ).toBe(400);
    expect(await profile(own.access)).toEqual(before);
  });

  it('requires bearer auth on every route and denies ordinary users all admin operations', async () => {
    const own = await signIn();
    const { id } = await profile(own.access);
    for (const [path, method, body] of [
      ['users/me', 'GET'],
      ['users/me', 'PATCH', { displayName: 'name' }],
      ['users/me/password', 'PATCH', passwordChange],
      ['users/me', 'DELETE'],
      ['users', 'GET'],
      [`users/${id}`, 'GET'],
      [`users/${id}`, 'PATCH', { role: 'admin' }],
      [`users/${id}`, 'DELETE'],
    ] as const) {
      const guest = await request(path, method, '', body);
      expect(guest.status).toBe(401);
      expect(guest.headers.get('cache-control')).toBe('no-store');
      if (!path.includes('/me')) {
        const denied = await request(path, method, own.access, body);
        expect(denied.status).toBe(403);
        expect(denied.headers.get('cache-control')).toBe('no-store');
      }
    }
  });

  it('changes password, preserves the verified current family, revokes others and retains replay detection', async () => {
    const own = await signIn();
    const other = await signIn('login');
    const foreign = await signIn('register', {
      ...input,
      email: 'foreign@example.test',
    });
    const response = await change(own.access, passwordChange, own.cookie);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.get('set-cookie')).toBeNull();
    const status = await sessions(own.access);
    expect(status.items.find((item) => item.current)?.status).toBe('active');
    expect(status.items.find((item) => !item.current)?.status).toBe('revoked');
    const [stored] = await db
      .select()
      .from(users)
      .where(eq(users.email, input.email));
    const passwords = app.get(PasswordsService);
    expect(
      await passwords.verify(passwordChange.newPassword, stored.passwordHash),
    ).toBe(true);
    expect(await passwords.verify(input.password, stored.passwordHash)).toBe(
      false,
    );
    expect((await request('auth/login', 'POST', '', input)).status).toBe(401);
    await signIn('login', { ...input, password: passwordChange.newPassword });
    expect((await refresh(other.cookie)).status).toBe(401);
    expect((await refresh(foreign.cookie)).status).toBe(200);
    const rotation = await refresh(own.cookie);
    expect(rotation.status).toBe(200);
    expect((await refresh(own.cookie)).status).toBe(401);
    expect((await refresh(cookie(rotation))).status).toBe(401);
    // Refresh revocation deliberately does not revoke already-issued access JWTs.
    expect((await request('users/me', 'GET', other.access)).status).toBe(200);
    for (const secret of [
      input.password,
      passwordChange.newPassword,
      stored.passwordHash,
      own.access,
      own.cookie.split('=')[1],
    ])
      expect(logs.join('\n')).not.toContain(secret);
  });

  it('rejects incorrect current passwords without writing or revoking', async () => {
    const own = await signIn();
    const [before] = await db.select().from(users);
    const response = await change(own.access, {
      ...passwordChange,
      currentPassword: 'incorrect password',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: 'Unable to change password',
    });
    expect(await db.select().from(users)).toEqual([before]);
    expect(await db.select().from(revoked)).toHaveLength(0);
    expect((await refresh(own.cookie)).status).toBe(200);
  });

  it.each([
    'missing',
    'invalid',
    'unknown',
    'foreign',
    'revoked',
    'expired',
  ] as const)(
    'does not preserve a family with %s current identity',
    async (kind) => {
      const own = await signIn();
      const other = await signIn('login');
      const foreign = await signIn('register', {
        ...input,
        email: 'foreign@example.test',
      });
      const owner = await profile(own.access);
      const ownSid = (await sessions(own.access)).items.find(
        (item) => item.current,
      )!.id;
      const foreignSid = (await sessions(foreign.access)).items[0].id;
      const sid =
        kind === 'missing'
          ? {}
          : {
              sid:
                kind === 'invalid'
                  ? 'invalid'
                  : kind === 'unknown'
                    ? randomUUID()
                    : kind === 'foreign'
                      ? foreignSid
                      : ownSid,
            };
      if (kind === 'revoked')
        await request(`auth/sessions/${ownSid}`, 'DELETE', own.access);
      if (kind === 'expired')
        await db
          .update(families)
          .set({ familyExpiresAt: new Date(0) })
          .where(eq(families.sessionId, ownSid));
      const signer = new JwtSigner({
        key: Buffer.from(authEnvironment.AUTH_SIGNING_KEY, 'hex'),
        type: 'at+jwt',
        ttl: '15m',
      });
      const bearer = signer.sign({ sub: owner.id, ...sid });
      const response = await change(bearer, passwordChange, foreign.cookie);
      expect(response.status).toBe(204);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(
        (await sessions(own.access)).items.every(
          (item) => item.status === 'revoked',
        ),
      ).toBe(true);
      expect((await refresh(own.cookie)).status).toBe(401);
      expect((await refresh(other.cookie)).status).toBe(401);
      expect((await refresh(foreign.cookie)).status).toBe(200);
    },
  );

  it.each(['other-device', 'foreign-user'] as const)(
    'preserves the browser cookie with bearer/cookie mismatch: %s',
    async (kind) => {
      const own = await signIn();
      const cookieLogin =
        kind === 'other-device'
          ? await signIn('login')
          : await signIn('register', {
              ...input,
              email: 'foreign@example.test',
            });
      const response = await change(
        own.access,
        passwordChange,
        cookieLogin.cookie,
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect((await refresh(own.cookie)).status).toBe(200);
      expect((await refresh(cookieLogin.cookie)).status).toBe(
        kind === 'other-device' ? 401 : 200,
      );
    },
  );

  it.each(['password', 'delete'] as const)(
    'rolls back %s if tombstone insertion fails, without clearing cookies or leaking SQL',
    async (operation) => {
      const own = await signIn();
      await signIn('login');
      const before = await db.select().from(users);
      // Trigger fails inside the real transaction, after the password UPDATE.
      await db.$client.query(
        `create function fail_revocation() returns trigger language plpgsql as $$ begin raise exception 'injected revocation failure'; end $$`,
      );
      await db.$client.query(
        'create trigger fail_revocation before insert on auth_revoked_families for each row execute function fail_revocation()',
      );
      try {
        const response =
          operation === 'password'
            ? await change(own.access, passwordChange, own.cookie)
            : await request('users/me', 'DELETE', own.access, {}, own.cookie);
        expect(response.status).toBe(503);
        expect(response.headers.get('set-cookie')).toBeNull();
        expect(await response.json()).toMatchObject({
          message: 'Account operation temporarily unavailable',
        });
        expect(await db.select().from(users)).toEqual(before);
        expect(await db.select().from(families)).toHaveLength(2);
        expect(await db.select().from(revoked)).toHaveLength(0);
      } finally {
        await db.$client.query(
          'drop trigger fail_revocation on auth_revoked_families',
        );
        await db.$client.query('drop function fail_revocation()');
      }
      expect(logs.join('\n')).not.toContain('injected revocation failure');
      expect(logs.join('\n')).not.toContain(before[0].passwordHash);
      expect((await refresh(own.cookie)).status).toBe(200);
    },
  );

  it('deletes only the authenticated account, retains tombstones, cascades tokens and rejects credentials after restart', async () => {
    const own = await signIn();
    const other = await signIn('login');
    const foreign = await signIn('register', {
      ...input,
      email: 'foreign@example.test',
    });
    const owner = await profile(own.access);
    const before = await db
      .select()
      .from(families)
      .where(eq(families.userId, owner.id));
    const unknownFamily = randomUUID();
    await db.insert(revoked).values({ familyId: unknownFamily });
    const store = app.get(PostgresRefreshTokenStore);
    const savedToken = (
      await db.select().from(tokens).where(eq(tokens.userId, owner.id))
    )[0];
    const savedRecord = (await store.getRefreshToken(savedToken.id))!;
    const response = await request(
      'users/me',
      'DELETE',
      own.access,
      {},
      own.cookie,
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expectCookieDeletion(response);
    expect(
      await db.select().from(families).where(eq(families.userId, owner.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(tokens).where(eq(tokens.userId, owner.id)),
    ).toHaveLength(0);
    expect(
      (await db.select().from(revoked)).map((row) => row.familyId).sort(),
    ).toEqual([...before.map((row) => row.familyId), unknownFamily].sort());
    await expect(
      store.saveRefreshToken({ ...savedRecord, id: randomUUID() }),
    ).rejects.toThrow();
    await app.close();
    await start();
    for (const login of [own, other]) {
      expect((await request('users/me', 'GET', login.access)).status).toBe(401);
      expect((await refresh(login.cookie)).status).toBe(401);
    }
    expect((await request('auth/login', 'POST', '', input)).status).toBe(401);
    expect((await profile(foreign.access)).email).toBe('foreign@example.test');
    expect((await refresh(foreign.cookie)).status).toBe(200);
    const replacement = await signIn();
    expect((await profile(replacement.access)).id).not.toBe(owner.id);
    expect((await request('users/me', 'GET', own.access)).status).toBe(401);
  });

  it('lets administrators get/update/assign roles/delete with explicit safe projections and self-target protection', async () => {
    const privileged = await admin();
    const own = await signIn();
    const target = await profile(own.access);
    const get = await request(`users/${target.id}`, 'GET', privileged.access);
    expect(publicUserResponseSchema.parse(await get.json())).toEqual(target);
    const update = await request(
      `users/${target.id}`,
      'PATCH',
      privileged.access,
      { role: 'admin', displayName: 'Managed', email: 'managed@example.test' },
    );
    expect(update.status).toBe(200);
    expect(publicUserResponseSchema.parse(await update.json())).toMatchObject({
      role: 'admin',
      displayName: 'Managed',
      email: 'managed@example.test',
    });
    expect((await request('users', 'GET', own.access)).status).toBe(200);
    expect(
      (
        await request(`users/${target.id}`, 'PATCH', privileged.access, {
          role: 'user',
        })
      ).status,
    ).toBe(200);
    expect((await request('users', 'GET', own.access)).status).toBe(403);
    for (const id of [privileged.id, privileged.id.toUpperCase()]) {
      expect(
        (await request(`users/${id}`, 'DELETE', privileged.access)).status,
      ).toBe(409);
      expect(
        (
          await request(`users/${id}`, 'PATCH', privileged.access, {
            role: 'user',
          })
        ).status,
      ).toBe(409);
    }
    const response = await request(
      `users/${target.id}`,
      'DELETE',
      privileged.access,
      {},
      privileged.cookie,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((await refresh(own.cookie)).status).toBe(401);
    expect((await request('users/me', 'GET', own.access)).status).toBe(401);
    expect(
      await db.select().from(families).where(eq(families.userId, target.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(tokens).where(eq(tokens.userId, target.id)),
    ).toHaveLength(0);
    expect(await db.select().from(revoked)).toHaveLength(1);
    expect((await refresh(privileged.cookie)).status).toBe(200);
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const missing = await request(
        `users/${target.id}`,
        method,
        privileged.access,
        method === 'PATCH' ? { displayName: 'Missing' } : undefined,
      );
      expect(missing.status).toBe(404);
    }
  });

  it('uses current database role rather than signed JWT role claims', async () => {
    const own = await signIn();
    const { id } = await profile(own.access);
    const signer = new JwtSigner({
      key: Buffer.from(authEnvironment.AUTH_SIGNING_KEY, 'hex'),
      type: 'at+jwt',
      ttl: '15m',
    });
    const bearer = signer.sign({ sub: id, role: 'admin' });
    expect((await request('users', 'GET', bearer)).status).toBe(403);
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, id));
    expect((await request('users', 'GET', own.access)).status).toBe(200);
    await db.update(users).set({ role: 'user' }).where(eq(users.id, id));
    expect((await request('users', 'GET', bearer)).status).toBe(403);
  });

  it('uses stable keyset pagination with tied timestamps and allowlisted sorting/search', async () => {
    const privileged = await admin();
    for (let i = 0; i < 5; i++)
      await signIn('register', { ...input, email: `search-${i}@example.test` });
    await db.update(users).set({ createdAt: new Date('2025-01-01T00:00:00Z') });
    for (const sort of ['createdAt', 'email'])
      for (const order of ['asc', 'desc']) {
        const query = `?search=SEARCH-&sort=${sort}&order=${order}`;
        const all = await list(privileged.access, query);
        const first = await list(privileged.access, `${query}&limit=2`);
        const next = await list(
          privileged.access,
          `${query}&limit=2&after=${first.nextCursor!}`,
        );
        const last = await list(
          privileged.access,
          `${query}&limit=2&after=${next.nextCursor!}`,
        );
        expect([...first.items, ...next.items, ...last.items]).toEqual(
          all.items,
        );
        expect(last.nextCursor).toBeNull();
        const values = all.items.map((item) =>
          sort === 'email' ? item.email : item.id,
        );
        expect(values).toEqual(
          order === 'asc' ? [...values].sort() : [...values].sort().reverse(),
        );
      }
    const all = await list(privileged.access);
    const first = await list(privileged.access, '?limit=2');
    await signIn('register', { ...input, email: 'newest@example.test' });
    const rest = await list(privileged.access, `?after=${first.nextCursor!}`);
    expect([...first.items, ...rest.items]).toEqual(all.items);
    expect(await list(privileged.access, `?after=${randomUUID()}`)).toEqual({
      items: [],
      nextCursor: null,
    });
    for (const search of ['%', '_', "' OR 1=1 --"])
      expect(
        (await list(privileged.access, `?search=${encodeURIComponent(search)}`))
          .items,
      ).toHaveLength(0);
    const target = all.items[0];
    await request(`users/${target.id}`, 'PATCH', privileged.access, {
      displayName: 'Unique Search Name',
    });
    expect(
      (await list(privileged.access, '?search=unique%20search')).items.map(
        (item) => item.id,
      ),
    ).toEqual([target.id]);
  });

  it('rejects malformed admin UUIDs, queries and bodies without exposing sensitive fields', async () => {
    const privileged = await admin();
    const own = await signIn();
    const { id } = await profile(own.access);
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=1.5',
      'limit=2&limit=3',
      'after=invalid',
      'search=',
      'search=' + 'x'.repeat(101),
      'sort=passwordHash',
      'sort=email%20desc',
      'order=random()',
      'role=admin',
    ])
      expect(
        (await request(`users?${query}`, 'GET', privileged.access)).status,
      ).toBe(400);
    for (const method of ['GET', 'PATCH', 'DELETE'])
      expect(
        (
          await request(
            'users/invalid',
            method,
            privileged.access,
            method === 'PATCH' ? { role: 'user' } : undefined,
          )
        ).status,
      ).toBe(400);
    for (const body of [
      {},
      { role: 'owner' },
      { passwordHash: 'secret' },
      { id },
      { createdAt: new Date().toISOString() },
    ])
      expect(
        (await request(`users/${id}`, 'PATCH', privileged.access, body)).status,
      ).toBe(400);
    expect(
      (
        await request(`users/${id}`, 'PATCH', privileged.access, {
          email: 'ADMIN@EXAMPLE.TEST',
        })
      ).status,
    ).toBe(409);
    const serialized = JSON.stringify(await list(privileged.access));
    for (const row of await db.select().from(users))
      expect(serialized).not.toContain(row.passwordHash);
    for (const name of [
      'passwordHash',
      'password_hash',
      'familyId',
      'claims',
      'accessToken',
      'refreshToken',
    ])
      expect(serialized).not.toContain(name);
  });

  it('requires trusted Origin for mutations, preserves native CSRF and supports credentialed PATCH/DELETE CORS', async () => {
    const own = await signIn();
    for (const origin of [null, 'null', 'https://evil.test']) {
      for (const [path, method, body] of [
        ['users/me', 'PATCH', { displayName: 'Changed' }],
        ['users/me/password', 'PATCH', passwordChange],
        ['users/me', 'DELETE', {}],
      ] as const) {
        const response = await request(
          path,
          method,
          own.access,
          body,
          own.cookie,
          origin,
          { 'Sec-Fetch-Site': 'cross-site' },
        );
        expect(response.status).toBe(403);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('set-cookie')).toBeNull();
      }
    }
    for (const method of ['PATCH', 'DELETE']) {
      const response = await request(
        'users/me',
        'OPTIONS',
        '',
        undefined,
        '',
        undefined,
        {
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-methods')).toContain(
        method,
      );
      expect(response.headers.get('access-control-allow-credentials')).toBe(
        'true',
      );
      expect(response.headers.get('access-control-allow-origin')).toBe(
        authEnvironment.AUTH_TRUSTED_ORIGINS,
      );
    }
    expect(
      (await request('users/me', 'GET', own.access, undefined, '', null))
        .status,
    ).toBe(200);
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

  it('preserves a verified current-family rotation queued behind password change', async () => {
    const own = await signIn();
    await signIn('login');
    const { id } = await profile(own.access);
    const blocker = await db.$client.connect();
    let changed!: Promise<Response>;
    let rotated!: Promise<Response>;
    try {
      await blocker.query('begin');
      await blocker.query('select id from users where id=$1 for update', [id]);
      changed = change(own.access);
      await waitForLocks(1);
      rotated = refresh(own.cookie);
      await waitForLocks(2);
    } finally {
      await blocker.query('commit');
      blocker.release();
    }
    expect((await changed).status).toBe(204);
    const response = await rotated;
    expect(response.status).toBe(200);
    expect((await refresh(cookie(response))).status).toBe(200);
    expect(
      (await sessions(own.access)).items.filter(
        (item) => item.status === 'active',
      ),
    ).toHaveLength(1);
  });

  it('rolls back deletion tombstones if the final user DELETE fails', async () => {
    const own = await signIn();
    await db.$client.query(
      `create function fail_deletion() returns trigger language plpgsql as $$ begin raise exception 'injected deletion failure'; end $$`,
    );
    await db.$client.query(
      'create trigger fail_deletion before delete on users for each row execute function fail_deletion()',
    );
    try {
      const response = await request(
        'users/me',
        'DELETE',
        own.access,
        {},
        own.cookie,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await db.select().from(revoked)).toHaveLength(0);
      expect(await db.select().from(users)).toHaveLength(1);
      expect(await db.select().from(families)).toHaveLength(1);
      expect(await db.select().from(tokens)).toHaveLength(1);
    } finally {
      await db.$client.query('drop trigger fail_deletion on users');
      await db.$client.query('drop function fail_deletion()');
    }
    expect((await refresh(own.cookie)).status).toBe(200);
  });

  it('allows only one of two password changes verified against the same stored hash', async () => {
    const own = await signIn();
    const { id } = await profile(own.access);
    const blocker = await db.$client.connect();
    let first!: Promise<Response>;
    let second!: Promise<Response>;
    try {
      await blocker.query('begin');
      await blocker.query('select id from users where id=$1 for update', [id]);
      first = change(own.access);
      await waitForLocks(1);
      second = change(own.access, {
        ...passwordChange,
        newPassword: 'second replacement password',
      });
      await waitForLocks(2);
    } finally {
      await blocker.query('commit');
      blocker.release();
    }
    expect((await first).status).toBe(204);
    expect((await second).status).toBe(409);
    const [stored] = await db.select().from(users);
    expect(
      await app
        .get(PasswordsService)
        .verify(passwordChange.newPassword, stored.passwordHash),
    ).toBe(true);
    expect(
      await app
        .get(PasswordsService)
        .verify('second replacement password', stored.passwordHash),
    ).toBe(false);
  });

  it.each(['login', 'refresh'] as const)(
    'serializes password change and concurrent %s in both lock orders',
    async (operation) => {
      for (const changeFirst of [false, true]) {
        await db.delete(users);
        await db.delete(revoked);
        const own = await signIn();
        const other = await signIn('login');
        const { id } = await profile(own.access);
        const blocker = await db.$client.connect();
        let changed!: Promise<Response>;
        let issued!: Promise<Response>;
        const issue = () =>
          operation === 'login'
            ? request('auth/login', 'POST', '', input)
            : refresh(other.cookie);
        try {
          await blocker.query('begin');
          await blocker.query('select id from users where id=$1 for update', [
            id,
          ]);
          if (changeFirst) changed = change(own.access);
          else issued = issue();
          await waitForLocks(1);
          if (changeFirst) issued = issue();
          else changed = change(own.access);
          await waitForLocks(2);
        } finally {
          await blocker.query('commit');
          blocker.release();
        }
        expect((await changed).status).toBe(204);
        const response = await issued;
        expect(changeFirst ? [401] : [200, 401]).toContain(response.status);
        if (response.status === 200)
          expect((await refresh(cookie(response))).status).toBe(401);
        expect((await refresh(other.cookie)).status).toBe(401);
        expect((await refresh(own.cookie)).status).toBe(200);
        await signIn('login', {
          ...input,
          password: passwordChange.newPassword,
        });
      }
    },
  );

  it.each(['login', 'refresh', 'password'] as const)(
    'serializes deletion and concurrent %s in both lock orders',
    async (operation) => {
      for (const deleteFirst of [false, true]) {
        await db.delete(users);
        await db.delete(revoked);
        const own = await signIn();
        const { id } = await profile(own.access);
        const blocker = await db.$client.connect();
        let deleted!: Promise<Response>;
        let raced!: Promise<Response>;
        const race = () =>
          operation === 'login'
            ? request('auth/login', 'POST', '', input)
            : operation === 'refresh'
              ? refresh(own.cookie)
              : change(own.access);
        const remove = () => request('users/me', 'DELETE', own.access);
        try {
          await blocker.query('begin');
          await blocker.query('select id from users where id=$1 for update', [
            id,
          ]);
          if (deleteFirst) deleted = remove();
          else raced = race();
          await waitForLocks(1);
          if (deleteFirst) raced = race();
          else deleted = remove();
          await waitForLocks(2);
        } finally {
          await blocker.query('commit');
          blocker.release();
        }
        expect((await deleted).status).toBe(204);
        const response = await raced;
        expect(operation === 'password' ? [204, 404] : [200, 401]).toContain(
          response.status,
        );
        if (operation !== 'password' && response.status === 200)
          expect((await refresh(cookie(response))).status).toBe(401);
        expect(await db.select().from(users)).toHaveLength(0);
        expect(await db.select().from(families)).toHaveLength(0);
        expect(await db.select().from(tokens)).toHaveLength(0);
        expect((await db.select().from(revoked)).length).toBeGreaterThan(0);
        expect((await refresh(own.cookie)).status).toBe(401);
        expect((await request('users/me', 'GET', own.access)).status).toBe(401);
      }
    },
  );
});
