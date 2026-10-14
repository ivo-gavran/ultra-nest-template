import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const stateFile = '.project-setup.json';
const usage = 'Usage: pnpm setup:project <project-name>';

class SetupError extends Error {}

// A deliberately bounded subset of unscoped npm names, also valid for the
// existing telemetry service-name schema. No escaping is needed in any target.
function validateName(args: string[]): string {
  const name = args[0];
  if (
    args.length !== 1 ||
    !name ||
    name.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(name) ||
    name.includes('..') ||
    ['node_modules', 'favicon.ico'].includes(name)
  ) {
    throw new SetupError(
      'Use an unscoped lowercase npm name of 1–63 characters: letters, digits, dots, underscores or hyphens; start and end with a letter or digit. No consecutive dots or reserved names.',
    );
  }
  return name;
}

function readProjectFile(path: string): string {
  // Reject symlinks in both files and ancestor directories rather than following
  // a customized checkout outside the project. All paths are fixed below.
  let current = root;
  const parts = path.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (
      stat.isSymbolicLink() ||
      (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
    ) {
      throw new SetupError(`Expected a regular project file: ${path}`);
    }
  }
  return readFileSync(current, 'utf8');
}

type Replacement = readonly [before: string, after: string, count?: number];
type Edit = readonly [path: string, replacements: readonly Replacement[]];

async function initialize(name: string): Promise<void> {
  const packageText = readProjectFile('package.json');
  const packageData: unknown = JSON.parse(packageText);
  if (
    !packageData ||
    typeof packageData !== 'object' ||
    !('name' in packageData)
  ) {
    throw new SetupError('Expected a package.json with a project name.');
  }
  // lstat also sees dangling symlinks, which existsSync alone would miss.
  let stateExists = false;
  try {
    lstatSync(join(root, stateFile));
    stateExists = true;
  } catch (error) {
    if (!(
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    )) {
      throw error;
    }
  }
  if (stateExists) {
    const state: unknown = JSON.parse(readProjectFile(stateFile));
    if (
      !state ||
      typeof state !== 'object' ||
      !('version' in state) ||
      state.version !== 1 ||
      !('name' in state) ||
      typeof state.name !== 'string' ||
      state.name !== packageData.name
    ) {
      throw new SetupError(
        'Initialization marker and package identity disagree; review them before continuing.',
      );
    }
    if (state.name !== name) {
      throw new SetupError(
        'Project already initialized with a different name. Reinitialization is not supported.',
      );
    }
    console.log(
      'Project already initialized with this name; no files changed.',
    );
    return;
  }
  if (packageData.name !== 'ultra-nest-template') {
    throw new SetupError(
      'Package identity was already customized. Initialize a fresh template checkout.',
    );
  }

  // Match complete, reviewed values in an explicit file list. Upstream URLs,
  // release history, fixtures and security settings are not replacement targets.
  const edits: Edit[] = [
    ['package.json', [['"name": "ultra-nest-template"', `"name": "${name}"`]]],
    [
      'README.md',
      [
        ['# Ultra Nest Template\n', `# ${name}\n`],
        [
          'A modular NestJS REST starter, officially released as',
          `${name} is a NestJS REST application based on the upstream Ultra Nest Template, officially released as`,
        ],
      ],
    ],
    [
      'src/configure-application.ts',
      [
        [".setTitle('Ultra Nest Template')", `.setTitle('${name}')`],
        [
          ".setDescription('NestJS starter API')",
          `.setDescription('${name} REST API')`,
        ],
      ],
    ],
    [
      'test/app.spec.ts',
      [
        ["title: 'Ultra Nest Template'", `title: '${name}'`],
        [
          "description: 'NestJS starter API'",
          `description: '${name} REST API'`,
        ],
      ],
    ],
    [
      'src/config/telemetry.ts',
      [[".default('ultra-nest-template')", `.default('${name}')`]],
    ],
    [
      'src/modules/observability/open-telemetry.ts',
      [["'ultra-nest-template.http'", `'${name}.http'`, 2]],
    ],
    [
      '.env.example',
      [
        [
          '# OTEL_SERVICE_NAME=ultra-nest-template\n',
          `# OTEL_SERVICE_NAME=${name}\n`,
        ],
      ],
    ],
    [
      'compose.yaml',
      [
        [
          'OTEL_SERVICE_NAME: ${OTEL_SERVICE_NAME:-ultra-nest-template}',
          `OTEL_SERVICE_NAME: \${OTEL_SERVICE_NAME:-${name}}`,
        ],
      ],
    ],
    [
      'scripts/verify-compose.sh',
      [
        [
          'record.service === "ultra-nest-template"',
          `record.service === "${name}"`,
        ],
      ],
    ],
    [
      'test/observability.spec.ts',
      [
        [
          "OTEL_SERVICE_NAME: 'ultra-nest-template'",
          `OTEL_SERVICE_NAME: '${name}'`,
        ],
      ],
    ],
    [
      'test/integration/observability.spec.ts',
      [
        [
          "telemetry.OTEL_SERVICE_NAME ?? 'ultra-nest-template'",
          `telemetry.OTEL_SERVICE_NAME ?? '${name}'`,
        ],
      ],
    ],
    [
      'test/integration/observability-bootstrap.spec.ts',
      [["'ultra-nest-template.http'", `'${name}.http'`, 2]],
    ],
    [
      'docs/observability.md',
      [
        ['`ultra-nest-template`', `\`${name}\``],
        ['"service": "ultra-nest-template"', `"service": "${name}"`],
      ],
    ],
    [
      'docs/docker-ci.md',
      [
        ['-t ultra-nest-template:local', `-t ${name}:local`],
        ['-t ultra-nest-template-migrate:local', `-t ${name}-migrate:local`],
      ],
    ],
    [
      'docs/health.md',
      [
        [
          'your-registry/ultra-nest-template:your-tag',
          `your-registry/${name}:your-tag`,
        ],
      ],
    ],
  ];

  // Complete validation and reads before writing anything, including the marker.
  const changes = edits.map(([path, replacements]) => {
    const before = readProjectFile(path);
    let after = before;
    for (const [from, to, count = 1] of replacements) {
      if (after.split(from).length - 1 !== count) {
        throw new SetupError(
          `Expected template identity is missing or ambiguous in ${path}. Initialize before customizing these values.`,
        );
      }
      after = after.split(from).join(to);
    }
    return { path, before, after };
  });

  // Reuse the installed, pinned formatter so table widths and long service
  // names also pass the existing checks. Formatting finishes before any write.
  const { format, resolveConfig } = await import('prettier');
  const options = await resolveConfig(join(root, 'package.json'), {
    config: join(root, 'prettier.config.ts'),
  });
  await Promise.all(
    changes.map(async (change) => {
      if (/\.(?:ts|json|md|yaml)$/.test(change.path)) {
        change.after = await format(change.after, {
          ...options,
          filepath: join(root, change.path),
        });
      }
    }),
  );

  const written: typeof changes = [];
  let markerWritten = false;
  try {
    for (const change of changes) {
      written.push(change);
      writeFileSync(join(root, change.path), change.after);
    }
    const marker = openSync(join(root, stateFile), 'wx');
    markerWritten = true;
    try {
      writeFileSync(
        marker,
        `${JSON.stringify({ version: 1, name }, null, 2)}\n`,
      );
    } finally {
      closeSync(marker);
    }
  } catch {
    // Restore originals on ordinary write errors. Like other local project
    // tooling, interruption/power loss still requires reviewing the Git diff.
    let restorationFailed = false;
    for (const change of written.reverse()) {
      try {
        writeFileSync(join(root, change.path), change.before);
      } catch {
        restorationFailed = true;
      }
    }
    if (markerWritten) {
      try {
        unlinkSync(join(root, stateFile));
      } catch {
        restorationFailed = true;
      }
    }
    throw new SetupError(
      restorationFailed
        ? 'Could not write project identity or fully restore files. Recover the affected files from Git before retrying.'
        : 'Could not write project identity; original files restored.',
    );
  }
  console.log(
    `Initialized ${name}. Review and commit the changes, then configure your untracked environment.`,
  );
}

try {
  await initialize(validateName(process.argv.slice(2)));
} catch (error) {
  // Do not echo unknown filesystem/JSON errors: their messages can contain
  // contents of customized files. Known validation errors contain no input data.
  const message =
    error instanceof SetupError
      ? error.message
      : 'Could not read or format the expected template files. Review the checkout and install dependencies before retrying.';
  console.error(`${message}\n${usage}`);
  process.exitCode = 1;
}
