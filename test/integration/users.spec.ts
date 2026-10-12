import { authEnvironment } from '../helpers/auth-environment.js';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import { ConfigService } from '@nestjs/config';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Test } from '@nestjs/testing';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { AppModule } from '../../src/app.module.js';
import { environmentSchema } from '../../src/config/environment.js';
import type { Database } from '../../src/database/database.module.js';
import { users } from '../../src/database/schema/users.js';
import { PasswordsService } from '../../src/modules/users/passwords.service.js';
import { publicUserSchema } from '../../src/modules/users/schemas/user.schema.js';
import {
  UserEmailConflictError,
  UserPersistenceError,
} from '../../src/modules/users/users.errors.js';
import { UsersRepository } from '../../src/modules/users/users.repository.js';
import { UsersService } from '../../src/modules/users/users.service.js';
import { startTestDatabase } from '../helpers/postgres.js';

const input = {
  email: '  Person@Example.com  ',
  password: 'test password phrase',
};

describe('Users persistence on PostgreSQL', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let db: Database;
  let service: UsersService;
  let passwords: PasswordsService;

  beforeAll(async () => {
    container = await startTestDatabase();
    const config = new ConfigService(
      environmentSchema.parse({
        ...authEnvironment,
        NODE_ENV: 'test',
        DATABASE_URL: container.getConnectionUri(),
      }),
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(config)
      // Only this test suite reduces scrypt work; runtime defaults are unchanged.
      .overrideProvider(PasswordHasher)
      .useValue(new PasswordHasher({ logN: 10 }))
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    db = app.get<Database>(getDrizzleToken());
    service = app.get(UsersService);
    passwords = app.get(PasswordsService);
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

  it('creates a normalized ordinary user and persists only a verifiable hash', async () => {
    const user = await service.create(input);
    expect(user).toMatchObject({
      email: 'person@example.com',
      displayName: null,
      role: 'user',
    });
    expect(publicUserSchema.safeParse(user).success).toBe(true);
    const [stored] = await db
      .select({ hash: users.passwordHash })
      .from(users)
      .where(eq(users.id, user.id));
    expect(stored.hash.startsWith('$scrypt$')).toBe(true);
    expect(stored.hash.includes(input.password)).toBe(false);
    expect(await passwords.verify(input.password, stored.hash)).toBe(true);
    expect(Object.keys(user).sort()).toEqual([
      'createdAt',
      'displayName',
      'email',
      'id',
      'role',
      'updatedAt',
    ]);
  });

  it('finds by UUID and normalized email without returning credentials', async () => {
    const user = await service.create(input);
    expect(await service.findById(user.id)).toEqual(user);
    expect(await service.findByEmail(' PERSON@example.COM ')).toEqual(user);
    expect(await service.findById(randomUUID())).toBeUndefined();
    expect(await service.findByEmail('missing@example.com')).toBeUndefined();
  });

  it('updates allowed fields and timestamps, clears names and preserves credentials/role', async () => {
    const user = await service.create({ ...input, displayName: 'Original' });
    const [before] = await db.select().from(users).where(eq(users.id, user.id));
    await db
      .update(users)
      .set({ updatedAt: new Date(0) })
      .where(eq(users.id, user.id));
    const updated = await service.update(user.id, {
      email: ' NEW@example.com ',
      displayName: ' New Name ',
    });
    expect(updated).toMatchObject({
      id: user.id,
      email: 'new@example.com',
      displayName: 'New Name',
      role: 'user',
      createdAt: user.createdAt,
    });
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(0);
    expect(Object.keys(updated!)).not.toContain('passwordHash');
    const [after] = await db
      .select({ hash: users.passwordHash })
      .from(users)
      .where(eq(users.id, user.id));
    expect(before.passwordHash === after.hash).toBe(true);
    expect(
      (await service.update(user.id, { displayName: null }))?.displayName,
    ).toBeNull();
    expect(
      await service.update(randomUUID(), { displayName: 'Missing' }),
    ).toBeUndefined();
  });

  it('maps duplicate normalized emails to a safe domain error', async () => {
    await service.create(input);
    await expect(
      service.create({ ...input, email: 'PERSON@EXAMPLE.COM' }),
    ).rejects.toBeInstanceOf(UserEmailConflictError);
  });

  it('enforces case-insensitive uniqueness even when application normalization is bypassed', async () => {
    const hash = await passwords.hash(input.password);
    await db
      .insert(users)
      .values({ email: 'Raw@Example.com', passwordHash: hash });
    await expect(
      db.insert(users).values({ email: 'raw@example.com', passwordHash: hash }),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'users_email_unique' },
    });
  });

  it('allows exactly one concurrent duplicate-email creation', async () => {
    const results = await Promise.allSettled([
      service.create({ ...input, email: 'Race@example.com' }),
      service.create({ ...input, email: 'race@EXAMPLE.COM' }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const failed = results.filter((result) => result.status === 'rejected');
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(UserEmailConflictError);
    expect(await db.select({ id: users.id }).from(users)).toHaveLength(1);
  });

  it('rejects a conflicting email update without modifying either user', async () => {
    const first = await service.create(input);
    const second = await service.create({
      ...input,
      email: 'second@example.com',
    });
    await expect(
      service.update(second.id, { email: first.email.toUpperCase() }),
    ).rejects.toBeInstanceOf(UserEmailConflictError);
    expect(await service.findById(second.id)).toEqual(second);
  });

  it('rejects mass assignment before persistence', async () => {
    const unsafeCreate = { ...input, role: 'admin' };
    await expect(service.create(unsafeCreate)).rejects.toThrow();
    expect(await db.select({ id: users.id }).from(users)).toHaveLength(0);
    const user = await service.create(input);
    const unsafeUpdate = {
      displayName: 'Attempt',
      role: 'admin',
      passwordHash: 'forbidden',
    };
    expect(() => service.update(user.id, unsafeUpdate)).toThrow();
    expect(await service.findById(user.id)).toEqual(user);
  });

  it('supports only user/admin roles at the database layer', async () => {
    const hash = await passwords.hash(input.password);
    const [admin] = await db
      .insert(users)
      .values({ email: 'admin@example.com', passwordHash: hash, role: 'admin' })
      .returning({ role: users.role });
    expect(admin.role).toBe('admin');
    await expect(
      db.execute(
        sql`insert into users (email, password_hash, role) values ('invalid@example.com', ${hash}, 'owner')`,
      ),
    ).rejects.toMatchObject({ cause: { code: '22P02' } });
  });

  it('sanitizes persistence failures so SQL parameters cannot escape', async () => {
    const repository = app!.get(UsersRepository);
    const hash = await passwords.hash(input.password);
    let failure: unknown;
    try {
      await repository.create({
        email: 'failure@example.com',
        passwordHash: hash,
        displayName: 'x'.repeat(101),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(UserPersistenceError);
    expect((failure as Error).message).toBe(
      'User persistence operation failed',
    );
    expect((failure as Error).cause).toBeUndefined();
    expect(String(failure).includes(hash)).toBe(false);
    expect(String(failure).includes('failure@example.com')).toBe(false);
  });
});
