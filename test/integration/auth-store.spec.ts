import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthenticationStorage,
  PasswordHasher,
  RefreshTokenError,
  TokenService,
} from '@nestjs/authentication';
import type {
  RefreshTokenRecord,
  RefreshTokenStore,
} from '@nestjs/authentication';
import { authenticationStoreContract } from '@nestjs/authentication/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Database } from '../../src/database/database.module.js';
import * as schema from '../../src/database/schema/index.js';
import {
  PostgresRefreshTokenStore,
  AuthStorageError,
} from '../../src/modules/auth/storage/postgres-refresh-token.store.js';
import { startTestDatabase } from '../helpers/postgres.js';
import { authEnvironment } from '../helpers/auth-environment.js';

describe('PostgreSQL refresh-token storage', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let store: PostgresRefreshTokenStore;
  let tokens: TokenService;
  let hash: string;
  beforeAll(async () => {
    container = await startTestDatabase();
    const pool = new Pool({
      connectionString: container.getConnectionUri(),
      max: 10,
    });
    db = drizzle<typeof schema>({ client: pool, schema });
    const storage = new AuthenticationStorage();
    store = new PostgresRefreshTokenStore(db, storage);
    tokens = new TokenService(storage, {
      accessToken: {
        key: Buffer.from(authEnvironment.AUTH_SIGNING_KEY, 'hex'),
      },
      refreshToken: { ttl: '7d', absoluteTtl: '7d' },
    });
    hash = await new PasswordHasher({ logN: 10 }).hash(
      'contract fixture password',
    );
  });
  beforeEach(async () => {
    await db.delete(schema.users);
    await db.delete(schema.authRevokedFamilies);
  });
  afterAll(async () => {
    try {
      await db?.$client.end();
    } finally {
      await container?.stop();
    }
  });

  const createUser = async (id: string = randomUUID()) => {
    await db
      .insert(schema.users)
      .values({ id, email: `${id}@example.test`, passwordHash: hash })
      .onConflictDoNothing();
    return id;
  };
  const record = (
    userId: string,
    familyId = randomUUID(),
  ): RefreshTokenRecord => ({
    id: randomUUID(),
    userId,
    familyId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60000),
    familyExpiresAt: new Date(Date.now() + 120000),
  });

  // Fixture adapter only: the official harness uses `user-<uuid>`, whereas our
  // users FK is UUID. Every actual contract operation delegates to the real store.
  const cases = authenticationStoreContract(
    () => {
      const toUuid = (id: string) => id.replace(/^user-/, '');
      const adapted: RefreshTokenStore = {
        async saveRefreshToken(value) {
          const userId = await createUser(toUuid(value.userId));
          await store.saveRefreshToken({ ...value, userId });
        },
        async getRefreshToken(id) {
          const value = await store.getRefreshToken(id);
          return value && { ...value, userId: `user-${value.userId}` };
        },
        markRefreshTokenUsed: (id, at) => store.markRefreshTokenUsed(id, at),
        revokeRefreshTokenFamily: (id) => store.revokeRefreshTokenFamily(id),
        isRefreshTokenFamilyRevoked: (id) =>
          store.isRefreshTokenFamilyRevoked(id),
        revokeUserRefreshTokens: (id) =>
          store.revokeUserRefreshTokens(toUuid(id)),
      };
      return { refreshTokens: adapted };
    },
    { contracts: ['refreshTokens'], concurrent: true },
  );
  for (const contract of cases)
    it(`official contract: ${contract.name}`, () => contract.run());

  it('keeps unknown-family revocation durable through its first insert', async () => {
    const value = record(await createUser());
    await store.revokeRefreshTokenFamily(value.familyId);
    await store.saveRefreshToken(value);
    expect(await store.isRefreshTokenFamilyRevoked(value.familyId)).toBe(true);
  });

  it('preserves session identity, owner, deadline and immutable app claims', async () => {
    const value = {
      ...record(await createUser()),
      claims: { sid: randomUUID(), amr: ['pwd'] },
    };
    await store.saveRefreshToken(value);
    for (const changes of [
      { userId: await createUser() },
      { claims: { sid: randomUUID() } },
      { claims: undefined },
      { familyExpiresAt: new Date(value.familyExpiresAt.getTime() + 1000) },
    ])
      await expect(
        store.saveRefreshToken({ ...value, ...changes, id: randomUUID() }),
      ).rejects.toBeInstanceOf(RefreshTokenError);
    const [family] = await db.select().from(schema.authTokenFamilies);
    expect(family.sessionId).toBe(value.claims.sid);
    expect(
      await db
        .select({ id: schema.authRefreshTokens.id })
        .from(schema.authRefreshTokens),
    ).toHaveLength(1);
  });

  it('rejects absent/deleted owners and rolls back an incomplete family insert', async () => {
    await expect(
      store.saveRefreshToken(record(randomUUID())),
    ).rejects.toBeInstanceOf(RefreshTokenError);
    const first = record(await createUser());
    await store.saveRefreshToken(first);
    const conflicting = { ...record(first.userId), id: first.id };
    await expect(store.saveRefreshToken(conflicting)).rejects.toBeInstanceOf(
      AuthStorageError,
    );
    expect(await db.select().from(schema.authTokenFamilies)).toHaveLength(1);
  });

  it('leaves an interrupted successor unusable after replay revokes its family', async () => {
    const first = record(await createUser());
    await store.saveRefreshToken(first);
    const successor = { ...first, id: randomUUID() };
    await store.saveRefreshToken(successor); // process dies before consuming parent
    expect((await store.getRefreshToken(first.id))?.usedAt).toBeUndefined();
    await store.markRefreshTokenUsed(first.id, new Date());
    await store.revokeRefreshTokenFamily(first.familyId);
    expect(await store.isRefreshTokenFamilyRevoked(successor.familyId)).toBe(
      true,
    );
  });

  it('revokeAll isolates owners and permits a subsequent new login', async () => {
    const user = await createUser();
    const other = await createUser();
    const first = await tokens.issue(user);
    const second = await tokens.issue(other);
    await tokens.revokeAll(user);
    await expect(tokens.refresh(first.refreshToken)).rejects.toBeInstanceOf(
      RefreshTokenError,
    );
    expect(
      (await tokens.refresh(second.refreshToken)).accessToken.length > 0,
    ).toBe(true);
    const next = await tokens.issue(user);
    expect(
      (await tokens.refresh(next.refreshToken)).accessToken.length > 0,
    ).toBe(true);
  });

  // Coordinate using observed PostgreSQL lock waits, never a timing assumption.
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

  it.each(['save-first', 'revoke-first'] as const)(
    'serializes logout-all against first issuance: %s',
    async (order) => {
      const user = await createUser();
      const value = record(user);
      const blocker = await db.$client.connect();
      const pending: Promise<void>[] = [];
      try {
        await blocker.query('begin');
        await blocker.query('select id from users where id=$1 for update', [
          user,
        ]);
        const save = () => store.saveRefreshToken(value);
        const revoke = () => store.revokeUserRefreshTokens(user);
        pending.push(order === 'save-first' ? save() : revoke());
        await waitForLocks(1);
        pending.push(order === 'save-first' ? revoke() : save());
        await waitForLocks(2);
      } finally {
        await blocker.query('commit');
        blocker.release();
      }
      await Promise.all(pending);
      expect(await store.isRefreshTokenFamilyRevoked(value.familyId)).toBe(
        order === 'save-first',
      );
    },
  );

  it('a successor queued after logout-all cannot restore an existing family', async () => {
    const user = await createUser();
    const value = record(user);
    await store.saveRefreshToken(value);
    const blocker = await db.$client.connect();
    const pending: Promise<void>[] = [];
    try {
      await blocker.query('begin');
      await blocker.query('select id from users where id=$1 for update', [
        user,
      ]);
      pending.push(store.revokeUserRefreshTokens(user));
      await waitForLocks(1);
      pending.push(store.saveRefreshToken({ ...value, id: randomUUID() }));
      await waitForLocks(2);
    } finally {
      await blocker.query('commit');
      blocker.release();
    }
    await Promise.all(pending);
    expect(await store.isRefreshTokenFamilyRevoked(value.familyId)).toBe(true);
    expect(
      await db
        .select({ id: schema.authRefreshTokens.id })
        .from(schema.authRefreshTokens),
    ).toHaveLength(2);
  });

  it('cascades credentials on account deletion but retains revocation evidence', async () => {
    const value = record(await createUser());
    await store.saveRefreshToken(value);
    await store.revokeRefreshTokenFamily(value.familyId);
    await db.delete(schema.users).where(eq(schema.users.id, value.userId));
    expect(await store.getRefreshToken(value.id)).toBeUndefined();
    expect(await store.isRefreshTokenFamilyRevoked(value.familyId)).toBe(true);
    expect(
      (
        await db.execute(
          sql`select count(*)::int as count from auth_token_families`,
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });

  it.each(['rotate-first', 'revoke-first'] as const)(
    'logout-all invalidates TokenService rotation successors: %s',
    async (order) => {
      const user = await createUser();
      const first = await tokens.issue(user);
      const blocker = await db.$client.connect();
      let rotation: ReturnType<TokenService['refresh']> | undefined;
      let revocation: Promise<void> | undefined;
      try {
        await blocker.query('begin');
        await blocker.query('select id from users where id=$1 for update', [
          user,
        ]);
        if (order === 'rotate-first')
          rotation = tokens.refresh(first.refreshToken);
        else revocation = tokens.revokeAll(user);
        await waitForLocks(1);
        if (order === 'rotate-first') revocation = tokens.revokeAll(user);
        else rotation = tokens.refresh(first.refreshToken);
        await waitForLocks(2);
      } finally {
        await blocker.query('commit');
        blocker.release();
      }
      const [pair] = await Promise.all([rotation!, revocation!]);
      await expect(tokens.refresh(pair.refreshToken)).rejects.toBeInstanceOf(
        RefreshTokenError,
      );
    },
  );
});
