import { authEnvironment } from '../helpers/auth-environment.js';
import 'reflect-metadata';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Test } from '@nestjs/testing';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { AppModule } from '../../src/app.module.js';
import { environmentSchema } from '../../src/config/environment.js';
import type { Database } from '../../src/database/database.module.js';
import { exampleRecords } from '../../src/database/schema/index.js';
import { migrateTestDatabase, startTestDatabase } from '../helpers/postgres.js';

async function createDatabaseApplication(connectionString: string) {
  const config = new ConfigService(
    environmentSchema.parse({
      ...authEnvironment,
      NODE_ENV: 'test',
      DATABASE_URL: connectionString,
    }),
  );
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ConfigService)
    .useValue(config)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

describe('PostgreSQL through Nest DI and real Drizzle migrations', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let db: Database;

  beforeAll(async () => {
    container = await startTestDatabase();
    app = await createDatabaseApplication(container.getConnectionUri());
    db = app.get<Database>(getDrizzleToken());
  });

  beforeEach(async () => {
    await db.delete(exampleRecords);
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await container?.stop();
    }
  });

  it('inserts and queries with database-generated UUIDs and timestamps', async () => {
    const [inserted] = await db
      .insert(exampleRecords)
      .values({ label: 'example' })
      .returning();
    expect(inserted.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserted.createdAt).toBeInstanceOf(Date);
    expect(
      await db.query.exampleRecords.findFirst({
        where: eq(exampleRecords.id, inserted.id),
      }),
    ).toEqual(inserted);
  });

  it('enforces uniqueness in PostgreSQL', async () => {
    await db.insert(exampleRecords).values({ label: 'duplicate' });
    await expect(
      db.insert(exampleRecords).values({ label: 'duplicate' }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('enforces NOT NULL in PostgreSQL', async () => {
    await expect(
      db.execute(sql`insert into example_records (label) values (null)`),
    ).rejects.toMatchObject({ cause: { code: '23502' } });
  });

  it('rejects blank labels via the database CHECK constraint', async () => {
    await expect(
      db.insert(exampleRecords).values({ label: '   ' }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('enforces the database length limit', async () => {
    await expect(
      db.insert(exampleRecords).values({ label: 'a'.repeat(81) }),
    ).rejects.toMatchObject({ cause: { code: '22001' } });
  });

  it('commits all statements in a successful transaction', async () => {
    await db.transaction(async (tx) => {
      await tx.insert(exampleRecords).values({ label: 'first' });
      await tx.insert(exampleRecords).values({ label: 'second' });
    });
    expect(
      await db
        .select({ label: exampleRecords.label })
        .from(exampleRecords)
        .orderBy(exampleRecords.label),
    ).toEqual([{ label: 'first' }, { label: 'second' }]);
  });

  it('rolls back earlier statements when a transaction violates a constraint', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(exampleRecords).values({ label: 'rollback' });
        await tx.insert(exampleRecords).values({ label: 'rollback' });
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    expect(await db.select().from(exampleRecords)).toEqual([]);
  });

  it('reruns the actual migration command without changing existing data or migration history', async () => {
    const [record] = await db
      .insert(exampleRecords)
      .values({ label: 'preserved' })
      .returning();
    const before = await db.$client.query(
      'select hash, created_at from drizzle.__drizzle_migrations',
    );
    expect(before.rows).toHaveLength(
      readMigrationFiles({ migrationsFolder: 'migrations' }).length,
    );
    await migrateTestDatabase(container!.getConnectionUri());
    expect(await db.select().from(exampleRecords)).toEqual([record]);
    const after = await db.$client.query(
      'select hash, created_at from drizzle.__drizzle_migrations',
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('closes a live pool on app.close and refuses further connections', async () => {
    const lifecycleApp = await createDatabaseApplication(
      container!.getConnectionUri(),
    );
    const pool = lifecycleApp.get<Database>(getDrizzleToken()).$client;
    try {
      await pool.query('select 1');
      expect(pool.totalCount).toBeGreaterThan(0);
    } finally {
      await lifecycleApp.close();
    }
    expect(pool.ended).toBe(true);
    expect(pool.totalCount).toBe(0);
    await expect(pool.query('select 1')).rejects.toThrow(/end/);
  });
});
