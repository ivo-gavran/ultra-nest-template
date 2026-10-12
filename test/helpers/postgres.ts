import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

const execFileAsync = promisify(execFile);

export async function migrateTestDatabase(
  connectionString: string,
): Promise<void> {
  await execFileAsync('pnpm', ['db:migrate'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: connectionString, NODE_ENV: 'test' },
    timeout: 60000,
  });
}

export async function startTestDatabase() {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('starter_test')
    .withUsername('starter_test')
    .withPassword('local-test-only')
    .start();
  try {
    await migrateTestDatabase(container.getConnectionUri());
    return container;
  } catch (error) {
    await container.stop();
    throw error;
  }
}
