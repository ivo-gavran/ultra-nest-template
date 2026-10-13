import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import { Controller, Get } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { JwtSigner, TokenService } from '@nestjs/authentication';
import { AuthorizationEvents, Can } from '@nestjs/authorization';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import type { Subscription } from 'rxjs';
import type { Database } from '../../src/database/database.module.js';
import { users, authRevokedFamilies } from '../../src/database/schema/index.js';
import { UsersPolicy } from '../../src/modules/authorization/policies/users.policy.js';
import { sessionPageSchema } from '../../src/modules/auth/schemas/session.schema.js';
import { createAuthApp } from '../helpers/auth-app.js';
import { authEnvironment } from '../helpers/auth-environment.js';
import { startTestDatabase } from '../helpers/postgres.js';

// No administrative or undeclared examples are imported by the production app.
@Controller('authorization-test')
class AuthorizationProbeController {
  @Get('admin')
  @Can(UsersPolicy, 'manage')
  admin() {
    return { allowed: true };
  }

  @Get('undeclared')
  undeclared() {
    return { mustNeverRun: true };
  }
}

const input = {
  email: 'authorization@example.test',
  password: 'test password phrase',
};

describe('Authorization with real bearer authentication and PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let db: Database;
  let url: string;
  let now: number;
  let subscription: Subscription;
  const denials: { reason: string; policy: string | null }[] = [];
  beforeAll(async () => {
    container = await startTestDatabase();
    now = Date.now();
    app = await createAuthApp(
      container.getConnectionUri(),
      () => now,
      false,
      authEnvironment.AUTH_TRUSTED_ORIGINS,
      [AuthorizationProbeController],
    );
    db = app.get<Database>(getDrizzleToken());
    url = await app.getUrl();
    subscription = app.get(AuthorizationEvents).events$.subscribe((event) => {
      // Capture only decision metadata; never log the event's user/arguments.
      denials.push({ reason: event.reason, policy: event.policy });
    });
  });
  beforeEach(async () => {
    now = Date.now();
    denials.length = 0;
    await db.delete(users);
    await db.delete(authRevokedFamilies);
  });
  afterAll(async () => {
    subscription?.unsubscribe();
    try {
      await app?.close();
    } finally {
      await container?.stop();
    }
  });
  const request = (
    path: string,
    token = '',
    method = 'GET',
    body?: unknown,
    cookie = '',
  ) =>
    fetch(`${url}/api/v1/${path}`, {
      method,
      headers: {
        Origin: authEnvironment.AUTH_TRUSTED_ORIGINS,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const register = async (email = input.email) => {
    const response = await request('auth/register', '', 'POST', {
      ...input,
      email,
    });
    expect(response.status).toBe(201);
    const { accessToken } = (await response.json()) as { accessToken: string };
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    return {
      accessToken,
      id: user.id,
      cookie: response.headers.get('set-cookie')!.split(';')[0],
    };
  };

  it('authenticates before authorization and denies ordinary users administrative permissions', async () => {
    const user = await register();
    for (const token of ['', 'invalid'])
      expect((await request('authorization-test/admin', token)).status).toBe(
        401,
      );
    expect(denials).toEqual([]); // Authentication stopped the chain before authorization.
    const forbidden = await request(
      'authorization-test/admin',
      user.accessToken,
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      message: 'Forbidden',
      statusCode: 403,
    });
    expect(denials).toEqual([{ reason: 'forbidden', policy: 'UsersPolicy' }]);
    const own = await request('auth-test-protected', user.accessToken);
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ id: user.id, role: 'user' });
  });

  it('reflects promotion and demotion on the next request with the same JWT', async () => {
    const user = await register();
    expect(
      (await request('authorization-test/admin', user.accessToken)).status,
    ).toBe(403);
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, user.id));
    const allowed = await request('authorization-test/admin', user.accessToken);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ allowed: true });
    await db.update(users).set({ role: 'user' }).where(eq(users.id, user.id));
    expect(
      (await request('authorization-test/admin', user.accessToken)).status,
    ).toBe(403);
  });

  it('ignores even signed stale role claims and rejects client-provided privilege hints', async () => {
    const user = await register();
    const stale = await app
      .get(TokenService)
      .issue(user.id, { claims: { role: 'admin' } });
    expect(
      (
        await request(
          `authorization-test/admin?role=admin&userId=${user.id}`,
          stale.accessToken,
        )
      ).status,
    ).toBe(403);
    expect(
      await (await request('auth-test-protected', stale.accessToken)).json(),
    ).toEqual({ id: user.id, role: 'user' });
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, user.id));
    const staleUser = await app
      .get(TokenService)
      .issue(user.id, { claims: { role: 'user' } });
    expect(
      (await request('authorization-test/admin', staleUser.accessToken)).status,
    ).toBe(200);
    await db.update(users).set({ role: 'user' }).where(eq(users.id, user.id));
    expect(
      (await request('authorization-test/admin', stale.accessToken)).status,
    ).toBe(403);
  });

  it.each(['user', 'admin'] as const)(
    'denies undeclared routes even to %s',
    async (role) => {
      const user = await register();
      await db.update(users).set({ role }).where(eq(users.id, user.id));
      expect((await request('authorization-test/undeclared')).status).toBe(401);
      const response = await request(
        'authorization-test/undeclared',
        user.accessToken,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ message: 'Forbidden' });
      expect(denials.at(-1)).toEqual({ reason: 'forbidden', policy: null });
    },
  );

  it('rejects forged, expired and deleted-account JWTs before authorization', async () => {
    const user = await register();
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, user.id));
    const forged = new JwtSigner({ key: randomBytes(32), type: 'at+jwt' }).sign(
      { sub: user.id, role: 'admin' },
    );
    expect((await request('authorization-test/admin', forged)).status).toBe(
      401,
    );
    now += 900000;
    expect(
      (await request('authorization-test/admin', user.accessToken)).status,
    ).toBe(401);
    now -= 900000;
    await db.delete(users).where(eq(users.id, user.id));
    expect(
      (await request('authorization-test/admin', user.accessToken)).status,
    ).toBe(401);
    expect(denials).toEqual([]);
  });

  it.each(['user', 'admin'] as const)(
    'keeps session ownership authoritative for %s without a cross-user override',
    async (role) => {
      const owner = await register();
      const foreign = await register('foreign-authorization@example.test');
      await db.update(users).set({ role }).where(eq(users.id, owner.id));
      const ownPage = sessionPageSchema.parse(
        await (await request('auth/sessions', owner.accessToken)).json(),
      );
      const foreignPage = sessionPageSchema.parse(
        await (await request('auth/sessions', foreign.accessToken)).json(),
      );
      expect(ownPage.items).toHaveLength(1);
      expect(ownPage.items[0].id).not.toBe(foreignPage.items[0].id);
      const response = await request(
        `auth/sessions/${foreignPage.items[0].id}`,
        owner.accessToken,
        'DELETE',
        undefined,
        foreign.cookie,
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await db.select().from(authRevokedFamilies)).toHaveLength(0);
      expect(
        (await request('auth/refresh', '', 'POST', {}, foreign.cookie)).status,
      ).toBe(200);
      const ownRevoke = await request(
        `auth/sessions/${ownPage.items[0].id}`,
        owner.accessToken,
        'DELETE',
        undefined,
        owner.cookie,
      );
      expect(ownRevoke.status).toBe(204);
      expect(ownRevoke.headers.get('set-cookie')).toContain('HttpOnly');
      expect(
        (await request('auth/refresh', '', 'POST', {}, owner.cookie)).status,
      ).toBe(401);
      expect(
        (await request('auth/logout-all', owner.accessToken, 'POST')).status,
      ).toBe(204);
    },
  );

  it('retains deliberately public starter and authentication routes', async () => {
    expect((await fetch(`${url}/api/v1`)).status).toBe(200);
    expect(
      (await request('greetings', '', 'POST', { name: 'public' })).status,
    ).toBe(200);
    const user = await register();
    const login = await request('auth/login', '', 'POST', input);
    expect(login.status).toBe(200);
    const rotated = await request('auth/refresh', '', 'POST', {}, user.cookie);
    expect(rotated.status).toBe(200);
    expect(
      (
        await request(
          'auth/logout',
          '',
          'POST',
          {},
          rotated.headers.get('set-cookie')!.split(';')[0],
        )
      ).status,
    ).toBe(204);
  });
});
