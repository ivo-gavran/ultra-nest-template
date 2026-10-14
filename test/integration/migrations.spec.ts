import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { PasswordHasher } from '@nestjs/authentication';
import { migrateTestDatabase, startTestDatabase } from '../helpers/postgres.js';

describe('Upgrade from the pre-users schema', () => {
  it('applies the actual new migration without losing existing example data', async () => {
    const container = await startTestDatabase(false);
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    const folder = mkdtempSync(join(tmpdir(), 'nest-pr05-migrations-'));
    try {
      mkdirSync(join(folder, 'meta'));
      copyFileSync(
        'migrations/0000_initial_example_records.sql',
        join(folder, '0000_initial_example_records.sql'),
      );
      const journal = JSON.parse(
        readFileSync('migrations/meta/_journal.json', 'utf8'),
      ) as { entries: unknown[] };
      writeFileSync(
        join(folder, 'meta/_journal.json'),
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }),
      );
      await migrate(drizzle(pool), { migrationsFolder: folder });
      const original = await pool.query(
        "insert into example_records (label) values ('pre-users') returning *",
      );
      expect(
        (await pool.query("select to_regclass('public.users') as table_name"))
          .rows,
      ).toEqual([{ table_name: null }]);
      await migrateTestDatabase(container.getConnectionUri());
      expect((await pool.query('select * from example_records')).rows).toEqual(
        original.rows,
      );
      expect(
        (await pool.query("select to_regclass('public.users') as table_name"))
          .rows,
      ).toEqual([{ table_name: 'users' }]);
      await migrateTestDatabase(container.getConnectionUri());
      expect((await pool.query('select * from example_records')).rows).toEqual(
        original.rows,
      );
    } finally {
      try {
        await pool.end();
      } finally {
        await container.stop();
        rmSync(folder, { recursive: true, force: true });
      }
    }
  });
});

describe('Upgrade from PR-05 to authentication', () => {
  it('preserves existing users, credentials and example data across the new migration and rerun', async () => {
    const container = await startTestDatabase(false);
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    const folder = mkdtempSync(join(tmpdir(), 'nest-pr06-migrations-'));
    try {
      mkdirSync(join(folder, 'meta'));
      for (const name of ['0000_initial_example_records.sql', '0001_users.sql'])
        copyFileSync(`migrations/${name}`, join(folder, name));
      const journal = JSON.parse(
        readFileSync('migrations/meta/_journal.json', 'utf8'),
      ) as { entries: unknown[] };
      writeFileSync(
        join(folder, 'meta/_journal.json'),
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, 2) }),
      );
      await migrate(drizzle(pool), { migrationsFolder: folder });
      const hash = await new PasswordHasher({ logN: 10 }).hash(
        'existing account password',
      );
      const original = await pool.query(
        "insert into users (email, password_hash, display_name, role) values ('existing@example.test', $1, 'Existing', 'admin') returning *",
        [hash],
      );
      const example = await pool.query(
        "insert into example_records (label) values ('pre-auth') returning *",
      );
      expect(
        (
          await pool.query(
            "select to_regclass('public.auth_refresh_tokens') as table_name",
          )
        ).rows,
      ).toEqual([{ table_name: null }]);
      await migrateTestDatabase(container.getConnectionUri());
      await migrateTestDatabase(container.getConnectionUri());
      // Compare as booleans so a failed assertion never prints stored credentials.
      expect(
        JSON.stringify((await pool.query('select * from users')).rows) ===
          JSON.stringify(original.rows),
      ).toBe(true);
      expect((await pool.query('select * from example_records')).rows).toEqual(
        example.rows,
      );
      expect(
        (
          await pool.query(
            'select count(*)::int as count from auth_refresh_tokens',
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    } finally {
      try {
        await pool.end();
      } finally {
        await container.stop();
        rmSync(folder, { recursive: true, force: true });
      }
    }
  });
});
