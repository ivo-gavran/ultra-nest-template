import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { format, resolveConfig } from 'prettier';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

const source = resolve(import.meta.dirname, '..');
const originalName = 'ultra-nest-template';
const projectName = 'harbor-orders-api';
const changedFiles = [
  'package.json',
  'README.md',
  'src/configure-application.ts',
  'test/app.spec.ts',
  'src/config/telemetry.ts',
  'src/modules/observability/open-telemetry.ts',
  '.env.example',
  'compose.yaml',
  'scripts/verify-compose.sh',
  'test/observability.spec.ts',
  'test/integration/observability.spec.ts',
  'test/integration/observability-bootstrap.spec.ts',
  'docs/observability.md',
  'docs/docker-ci.md',
  'docs/health.md',
];
const excluded = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.test-process-dist',
  '.test-manual-dist',
  '.DS_Store',
  '.project-setup.json',
]);

function fingerprint(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  function visit(directory: string) {
    for (const name of readdirSync(join(root, directory)).sort()) {
      const path = directory ? `${directory}/${name}` : name;
      if (excluded.has(name) && name !== '.project-setup.json') continue;
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) {
        files[path] = createHash('sha256')
          .update(readFileSync(join(root, path)))
          .digest('hex');
      }
    }
  }
  visit('');
  return files;
}

// The suite must also run in an initialized application. Restore only known
// branding in its temporary fixture, without changing the real source checkout.
async function restoreTemplateBranding(root: string) {
  const manifest = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ) as { name: string };
  const name = manifest.name;
  if (
    name === originalName &&
    readFileSync(join(root, 'README.md'), 'utf8').startsWith(
      '# Ultra Nest Template\n',
    )
  )
    return;
  const options = await resolveConfig(join(root, 'package.json'), {
    config: join(root, 'prettier.config.ts'),
  });
  const replacements: Record<string, [string, string][]> = {
    'package.json': [[`"name": "${name}"`, `"name": "${originalName}"`]],
    'README.md': [
      [`# ${name}\n`, '# Ultra Nest Template\n'],
      [
        `${name} is a NestJS REST application based on the upstream Ultra Nest Template, officially released as`,
        'A modular NestJS REST starter, officially released as',
      ],
    ],
    'src/configure-application.ts': [
      [`.setTitle('${name}')`, ".setTitle('Ultra Nest Template')"],
      [
        `.setDescription('${name} REST API')`,
        ".setDescription('NestJS starter API')",
      ],
    ],
    'test/app.spec.ts': [
      [`title: '${name}'`, "title: 'Ultra Nest Template'"],
      [`description: '${name} REST API'`, "description: 'NestJS starter API'"],
    ],
    'src/config/telemetry.ts': [
      [`.default('${name}')`, `.default('${originalName}')`],
    ],
    'src/modules/observability/open-telemetry.ts': [
      [`'${name}.http'`, `'${originalName}.http'`],
    ],
    '.env.example': [
      [
        `# OTEL_SERVICE_NAME=${name}\n`,
        `# OTEL_SERVICE_NAME=${originalName}\n`,
      ],
    ],
    'compose.yaml': [
      [
        `OTEL_SERVICE_NAME: \${OTEL_SERVICE_NAME:-${name}}`,
        `OTEL_SERVICE_NAME: \${OTEL_SERVICE_NAME:-${originalName}}`,
      ],
    ],
    'scripts/verify-compose.sh': [
      [`record.service === "${name}"`, `record.service === "${originalName}"`],
    ],
    'test/observability.spec.ts': [
      [`OTEL_SERVICE_NAME: '${name}'`, `OTEL_SERVICE_NAME: '${originalName}'`],
    ],
    'test/integration/observability.spec.ts': [
      [
        `telemetry.OTEL_SERVICE_NAME ?? '${name}'`,
        `telemetry.OTEL_SERVICE_NAME ?? '${originalName}'`,
      ],
    ],
    'test/integration/observability-bootstrap.spec.ts': [
      [`'${name}.http'`, `'${originalName}.http'`],
    ],
    'docs/observability.md': [
      [`\`${name}\``, `\`${originalName}\``],
      [`"service": "${name}"`, `"service": "${originalName}"`],
    ],
    'docs/docker-ci.md': [
      [`-t ${name}:local`, `-t ${originalName}:local`],
      [`-t ${name}-migrate:local`, `-t ${originalName}-migrate:local`],
    ],
    'docs/health.md': [
      [
        `your-registry/${name}:your-tag`,
        `your-registry/${originalName}:your-tag`,
      ],
    ],
  };
  for (const [path, pairs] of Object.entries(replacements)) {
    let text = readFileSync(join(root, path), 'utf8');
    for (const [from, to] of pairs) text = text.split(from).join(to);
    if (/\.(?:ts|json|md|yaml)$/.test(path))
      text = await format(text, { ...options, filepath: join(root, path) });
    writeFileSync(join(root, path), text);
  }
}

describe('Project initialization CLI in an isolated starter copy', () => {
  let root: string;
  let before: Record<string, string>;
  let sourceBefore: Record<string, string>;
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [join(root, 'scripts/setup-project.ts'), ...args],
      {
        cwd: tmpdir(), // Resolve the project from the script, never the caller's cwd.
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
  const failedWithoutEdits = (...args: string[]) => {
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: pnpm setup:project <project-name>');
    expect(fingerprint(root)).toEqual(before);
  };

  beforeAll(() => {
    sourceBefore = fingerprint(source);
  });
  afterAll(() => {
    expect(fingerprint(source)).toEqual(sourceBefore);
  });
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'nest-setup-test-'));
    cpSync(source, root, {
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
    await restoreTemplateBranding(root);
    symlinkSync(
      join(source, 'node_modules'),
      join(root, 'node_modules'),
      'dir',
    );
    // Synthetic credentials only: the initializer must preserve existing local
    // environment contents and must never echo them, even on rejected inputs.
    writeFileSync(
      join(root, '.env'),
      'AUTH_SIGNING_KEY=synthetic-private-placeholder\nOTEL_SERVICE_NAME=custom-service\nPOSTGRES_PASSWORD=synthetic-password\n',
    );
    before = fingerprint(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('updates only the documented files, preserves security/credentials and keeps the lockfile unchanged', async () => {
    const result = run(projectName);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toMatch(
      /synthetic-private|synthetic-password/,
    );
    const after = fingerprint(root);
    expect(
      Object.keys(after)
        .filter((path) => after[path] !== before[path])
        .sort(),
    ).toEqual([...changedFiles, '.project-setup.json'].sort());
    expect(Object.keys(before).every((path) => path in after)).toBe(true);
    expect(JSON.parse(read('package.json'))).toMatchObject({
      name: projectName,
      version: '1.0.0',
      private: true,
    });
    expect(read('pnpm-lock.yaml')).not.toContain('name: ultra-nest-template');
    expect(after['pnpm-lock.yaml']).toBe(before['pnpm-lock.yaml']);
    expect(read('src/configure-application.ts')).toContain(
      `.setTitle('${projectName}')`,
    );
    expect(read('src/configure-application.ts')).toContain(
      `.setDescription('${projectName} REST API')`,
    );
    expect(read('src/config/telemetry.ts')).toContain(
      `.default('${projectName}')`,
    );
    expect(read('src/modules/observability/open-telemetry.ts')).toContain(
      `getTracer('${projectName}.http')`,
    );
    expect(read('src/modules/observability/open-telemetry.ts')).toContain(
      `getMeter('${projectName}.http')`,
    );
    expect(read('compose.yaml')).toContain(
      `OTEL_SERVICE_NAME: \${OTEL_SERVICE_NAME:-${projectName}}`,
    );
    for (const path of changedFiles.filter((path) => path !== 'README.md')) {
      expect(read(path), path).not.toContain(originalName);
    }
    expect(read('README.md')).toContain(
      'https://github.com/ivo-gavran/ultra-nest-template/releases/tag/v1.0.0',
    );
    expect(read('README.md')).toContain(`# ${projectName}\n`);
    expect(read('.env.example')).toContain('AUTH_SIGNING_KEY=\n');
    expect(read('.env.example')).toContain(
      'POSTGRES_PASSWORD=local-development-only',
    );
    expect(after['.env']).toBe(before['.env']);
    expect(JSON.parse(read('.project-setup.json'))).toEqual({
      version: 1,
      name: projectName,
    });
    await restoreTemplateBranding(root);
    rmSync(join(root, '.project-setup.json'));
    expect(fingerprint(root)).toEqual(before);
  });

  it.each(['a', 'api_v2.example', 'a'.repeat(63), originalName])(
    'accepts the bounded npm name %s',
    (name) => {
      expect(run(name).status).toBe(0);
      expect(run(name).status).toBe(0);
      const initialized = fingerprint(root);
      expect(run('different-api').status).toBe(1);
      expect(fingerprint(root)).toEqual(initialized);
    },
  );

  it.each([
    '',
    'My-Api',
    '../api',
    'a..b',
    'a/b',
    'a\\b',
    '@scope/api',
    '.api',
    '_api',
    'api-',
    ' api',
    'api ',
    'api\n',
    'api%20name',
    'api;echo',
    '$(whoami)',
    '`whoami`',
    'node_modules',
    'favicon.ico',
    'a'.repeat(64),
  ])('rejects unsafe or unsupported name %j before writes', (name) => {
    failedWithoutEdits(name);
  });
  it('rejects missing and extra arguments', () => {
    failedWithoutEdits();
    failedWithoutEdits(projectName, 'extra');
  });
  it('is a byte-for-byte no-op on repeat, preserving subsequent customization', () => {
    expect(run(projectName).status).toBe(0);
    writeFileSync(
      join(root, 'README.md'),
      `${read('README.md')}\nApplication-specific notes.\n`,
    );
    const initialized = fingerprint(root);
    expect(run(projectName).status).toBe(0);
    expect(fingerprint(root)).toEqual(initialized);
    expect(run('different-api').stderr).toContain('different name');
    expect(fingerprint(root)).toEqual(initialized);
  });
  it('preflights a late missing identity before changing earlier files', () => {
    writeFileSync(join(root, 'docs/health.md'), 'Customized health guide.\n');
    before = fingerprint(root);
    failedWithoutEdits(projectName);
  });
  it('preflights a missing target before changing earlier files', () => {
    rmSync(join(root, 'docs/health.md'));
    before = fingerprint(root);
    failedWithoutEdits(projectName);
  });
  it('keeps maximum-length names formatted without manual cleanup', () => {
    const result = run('a'.repeat(63));
    expect(result.status, result.stderr).toBe(0);
    const checked = spawnSync('pnpm', ['format:check'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  }, 30_000);
  it('rejects customized package identity without a marker', () => {
    writeFileSync(
      join(root, 'package.json'),
      read('package.json').replace(
        '"name": "ultra-nest-template"',
        '"name": "custom-api"',
      ),
    );
    before = fingerprint(root);
    failedWithoutEdits(projectName);
  });
  it('rejects marker/package disagreement and malformed state without leaking file contents', () => {
    for (const marker of [
      '{"version":1,"name":"different-api"}',
      'synthetic-private-placeholder',
    ]) {
      writeFileSync(join(root, '.project-setup.json'), marker);
      before = fingerprint(root);
      failedWithoutEdits(projectName);
      expect(run(projectName).stderr).not.toContain(
        'synthetic-private-placeholder',
      );
    }
  });
  it.each([false, true])(
    'restores earlier writes after an injected filesystem failure (persistent=%s)',
    (persistent) => {
      // A deterministic Node preload injects failure at the last target, avoiding
      // permission/root differences and race-prone timing in filesystem tests.
      const preload = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const write = fs.writeFileSync;
      let failed = false;
      fs.writeFileSync = (file, ...args) => {
        if (String(file).endsWith('/docs/health.md') && (${persistent} || !failed)) {
          failed = true;
          if (!${persistent}) write(file, 'interrupted write');
          throw Object.assign(new Error('synthetic-private-placeholder'), { code: 'EIO' });
        }
        return write(file, ...args);
      };
      syncBuiltinESMExports();
    `;
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          `data:text/javascript,${encodeURIComponent(preload)}`,
          join(root, 'scripts/setup-project.ts'),
          projectName,
        ],
        { cwd: root, encoding: 'utf8', timeout: 10_000 },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        persistent ? 'fully restore' : 'original files restored',
      );
      expect(result.stdout + result.stderr).not.toContain(
        'synthetic-private-placeholder',
      );
      expect(fingerprint(root)).toEqual(before);
    },
  );
  it('rejects a symlinked target without editing its destination or other files', () => {
    const external = join(root, 'external-telemetry.ts');
    writeFileSync(external, read('src/config/telemetry.ts'));
    rmSync(join(root, 'src/config/telemetry.ts'));
    symlinkSync(external, join(root, 'src/config/telemetry.ts'));
    before = fingerprint(root);
    failedWithoutEdits(projectName);
  });
});
