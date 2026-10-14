import { authEnvironment } from './helpers/auth-environment.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const main = fileURLToPath(
  new URL('../.test-process-dist/src/main.js', import.meta.url),
);
const schemaModule = new URL(
  '../.test-process-dist/src/config/environment.js',
  import.meta.url,
).href;
const configModule = import.meta.resolve('@nestjs/config');

describe('Configuration at process startup', () => {
  it.each([
    ['missing database URL', '', 'DATABASE_URL'],
    [
      'missing signing key',
      'DATABASE_URL=postgresql://localhost/test',
      'AUTH_SIGNING_KEY',
    ],
    [
      'invalid signing key',
      'DATABASE_URL=postgresql://localhost/test\nAUTH_SIGNING_KEY=private-test-password',
      'AUTH_SIGNING_KEY',
    ],
    [
      'missing origins',
      'DATABASE_URL=postgresql://localhost/test',
      'AUTH_TRUSTED_ORIGINS',
    ],
    [
      'invalid database URL',
      'DATABASE_URL=https://user:private-test-password@localhost/test',
      'DATABASE_URL',
    ],
    [
      'invalid port',
      'DATABASE_URL=postgresql://user:private-test-password@localhost/test\nPORT=0',
      'PORT',
    ],
    [
      'invalid environment',
      'DATABASE_URL=postgresql://localhost/test\nNODE_ENV=staging',
      'NODE_ENV',
    ],
    [
      'invalid Swagger flag',
      'DATABASE_URL=postgresql://localhost/test\nSWAGGER_ENABLED=yes',
      'SWAGGER_ENABLED',
    ],
  ])('exits before listening for %s', (_label, dotenv, key) => {
    const cwd = mkdtempSync(join(tmpdir(), 'nest-pr02-startup-'));
    try {
      writeFileSync(join(cwd, '.env'), dotenv);
      const result = spawnSync(process.execPath, [main], {
        cwd,
        env: { NO_COLOR: '1' },
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.signal).toBeNull();
      const output = result.stdout + result.stderr;
      expect(output).toContain('Config validation error');
      expect(output).toContain(key);
      expect(output).not.toContain('private-test-password');
      expect(output).not.toContain('Nest application successfully started');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('loads .env, honors process overrides and exposes validated typed values', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nest-pr02-dotenv-'));
    try {
      writeFileSync(
        join(cwd, '.env'),
        'DATABASE_URL=postgresql://localhost/test\nPORT=3100\nNODE_ENV=production\n',
      );
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { ConfigModule, ConfigService } from ${JSON.stringify(configModule)};
        import { environmentSchema } from ${JSON.stringify(schemaModule)};
        import { NestFactory } from ${JSON.stringify(import.meta.resolve('@nestjs/core'))};
        const app = await NestFactory.createApplicationContext(
          await ConfigModule.forRoot({ validationSchema: environmentSchema, skipProcessEnv: true }),
          { logger: false },
        );
        const config = app.get(ConfigService);
        process.env.PORT = '9999';
        console.log(JSON.stringify({ port: config.get('PORT'), docs: config.get('SWAGGER_ENABLED'), database: config.get('DATABASE_URL') }));
        await app.close();
      `,
        ],
        {
          cwd,
          env: { PORT: '3200', ...authEnvironment },
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        port: 3200,
        docs: false,
        database: 'postgresql://localhost/test',
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
