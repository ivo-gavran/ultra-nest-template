# Ultra Nest Template

A modular NestJS REST starter, currently at **PR-01: bootstrap and developer tooling**. The application exposes a public `GET /` returning `Hello World!`. Authentication, database integration, environment validation and Swagger arrive in subsequent milestones.

## Requirements and installation

- Node **24.21.0 LTS**, pinned in `.nvmrc`.
- pnpm **10.33.0**, pinned through `packageManager`.
- Git for local hooks. No Docker, database or external service is needed for PR-01.

```sh
git clone https://github.com/ivo-gavran/ultra-nest-template.git
cd ultra-nest-template
nvm install
nvm use
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install --frozen-lockfile
pnpm hooks:install
```

Corepack is bundled with the selected Node release; if your Node distribution omits it, install Corepack using its official installation instructions before enabling it. `pnpm hooks:install` runs `lefthook install` and must be run once per clone; it is explicit so dependency installation also works without Git or with production-only dependencies. Dependency install scripts for Nest's optional donation message and Lefthook's automatic hook installation are disabled in `pnpm-workspace.yaml`.

## Development and production build

```sh
pnpm start:dev
# GET http://localhost:3000/ -> Hello World!
```

The Nest CLI compiles TypeScript and restarts on source changes. `PORT` defaults to `3000`; to override on a POSIX shell, use `PORT=3001 pnpm start:dev`. PR-01 reads process environment only: `.env.example` documents future settings, but copying it to `.env` does not enable automatic loading yet. `DATABASE_URL` is unused at this stage.

```sh
pnpm build
pnpm start
```

Production output is ESM in `dist/`, with source maps and no tests. Keep `package.json` beside the output so Node retains ESM mode. Local TypeScript imports use `.js` extensions. TypeScript **6.0.3** and NestJS **12.1.3** retain the compatibility decisions from PR-00.

## Checks and tests

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

Use `pnpm format` to format application code and current tooling/docs. The supplied plans, ADRs and PR-00 snapshot are excluded from root formatting to preserve their contents; the compatibility spike also remains outside root lint, build and tests.

Jest runs JavaScript compiled by the pinned TypeScript compiler into `.test-dist/`, preserving ESM and Nest decorator metadata. `pnpm test` cleans/rebuilds this output first, then runs the bootstrap HTTP tests on an ephemeral loopback port; the server closes afterwards. Node's `--experimental-vm-modules` is required for Jest ESM and may print an experimental warning. No ts-jest/Babel transformer is needed. Database integration/E2E infrastructure will be introduced in its own milestone.

The original spike has its own installation and lockfile:

```sh
cd spikes/pr-00
pnpm install --frozen-lockfile --ignore-scripts --ignore-workspace
pnpm --ignore-workspace typecheck
pnpm --ignore-workspace test
```

## Git conventions

Use feature branches and Conventional Commits, for example `feat(users): add profile endpoint`. Lefthook runs ESLint and Prettier checks for staged file paths on `pre-commit`, and Commitlint on `commit-msg`. Hooks check the working copies of those files and do not auto-fix or restage them; format/fix and stage your changes explicitly. The full test suite and build are not run in a commit hook. Keep the pinned Node and pnpm on PATH when committing from a terminal or editor.

To check a message independently:

```sh
echo 'feat: add example' | pnpm exec commitlint
echo 'invalid message' | pnpm exec commitlint # must exit nonzero
```

## Architecture and roadmap

- [Implementation plan](NESTJS_STARTER_IMPLEMENTATION_PLAN.md)
- [Agent/contribution rules](AGENTS.md)
- [PR-00 compatibility evidence](docs/pr-00-compatibility.md)
- [PR-01 verification results](docs/pr-01-verification.md)
- [Browser auth transport](docs/adr/001-auth-transport.md)
- [Bearer session model](docs/adr/002-auth-session-model.md)

PR-02 adds configuration validation and HTTP conventions; PR-03 adds persistence; CI/Docker follow in PR-04. Optional extensions remain opt-in.
