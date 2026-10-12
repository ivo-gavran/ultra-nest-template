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
import { describe, expect, it } from '@jest/globals';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
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
