import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const source = resolve(import.meta.dirname, '..');
const temporary = mkdtempSync(join(tmpdir(), 'nest-template-verification-'));
const project = join(temporary, 'harbor-orders-api');
const excluded = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.test-process-dist',
  '.test-manual-dist',
  '.DS_Store',
]);

function run(command: string, args: string[]) {
  console.log(
    `\nVerifying initialized application: ${command} ${args.join(' ')}`,
  );
  const result = spawnSync(command, args, { cwd: project, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Initialized application check failed: ${command} ${args.join(' ')}`,
    );
  }
}

try {
  cpSync(source, project, {
    recursive: true,
    filter: (path) =>
      relative(source, path)
        .split(/[\\/]/)
        .every(
          (part) =>
            !excluded.has(part) &&
            !(part.startsWith('.env') && part !== '.env.example') &&
            !part.endsWith('.log'),
        ),
  });
  run('pnpm', ['install', '--frozen-lockfile']);
  const manifest: unknown = JSON.parse(
    readFileSync(join(project, 'package.json'), 'utf8'),
  );
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !('name' in manifest) ||
    typeof manifest.name !== 'string'
  ) {
    throw new Error('Expected a package manifest with a project name.');
  }
  // From the source template, verify a new name. From an initialized app, keep
  // its recorded identity and verify repeat execution and all existing checks.
  const name = existsSync(join(project, '.project-setup.json'))
    ? manifest.name
    : 'harbor-orders-api';
  run('pnpm', ['setup:project', name]);
  run('pnpm', ['setup:project', name]);
  run('pnpm', ['install', '--frozen-lockfile']);
  for (const command of [
    'lint',
    'format:check',
    'typecheck',
    'test:cov',
    'test:e2e',
    'build',
    'verify:build',
  ]) {
    run('pnpm', [command]);
  }
  run('bash', ['scripts/verify-compose.sh']);
  console.log(
    '\nInitialized application passed all template verification gates.',
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
