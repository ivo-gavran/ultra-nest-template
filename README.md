# Ultra Nest Template

A modular NestJS REST starter, currently at **PR-02: configuration, validation, HTTP conventions and Swagger**. The application exposes `GET /api/v1` and a strict Zod example at `POST /api/v1/greetings`. Environment configuration is validated before the HTTP server starts.

## Requirements and installation

- Node **24.21.0 LTS**, pinned in `.nvmrc`.
- pnpm **10.33.0**, pinned through `packageManager`.
- Git for local hooks. No running database, Docker or external service is needed for this milestone.

```sh
git clone https://github.com/ivo-gavran/ultra-nest-template.git
cd ultra-nest-template
nvm install
nvm use
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install --frozen-lockfile
pnpm hooks:install
cp .env.example .env
```

Corepack is bundled with the selected Node release; if your Node distribution omits it, install Corepack using its official installation instructions before enabling it. `pnpm hooks:install` runs `lefthook install` and must be run once per clone; it is explicit so dependency installation also works without Git or with production-only dependencies. Dependency install scripts for Nest's optional donation message, Scarf's install telemetry and Lefthook's automatic hook installation are disabled in `pnpm-workspace.yaml`.

## Development and production build

```sh
pnpm start:dev
# GET http://localhost:3000/api/v1 -> Hello World!
# Swagger UI: http://localhost:3000/docs
```

The Nest CLI compiles TypeScript and restarts on source changes. Configuration loads from `.env` in the current working directory; process environment values take precedence. Restart after changing environment settings. For example, use `PORT=3001 pnpm start:dev` on a POSIX shell.

| Variable          | Accepted values                       | Default                                 |
| ----------------- | ------------------------------------- | --------------------------------------- |
| `NODE_ENV`        | `development`, `test`, `production`   | `development`                           |
| `PORT`            | Decimal integer from 1 to 65535       | `3000`                                  |
| `DATABASE_URL`    | PostgreSQL URL with host and database | Required                                |
| `SWAGGER_ENABLED` | Literal `true` or `false`             | `false` in production, otherwise `true` |

Missing `DATABASE_URL`, invalid ports or invalid flags prevent startup. Empty strings are invalid. The URL is validated now as required by PR-02; no database connection is opened until PR-03. Example credentials are for local development only. Keep `.env` untracked and inject production values through the deployment environment.

```sh
pnpm build
pnpm start
```

Production output is ESM in `dist/`, with source maps and no tests. Keep `package.json` beside the output so Node retains ESM mode. Local TypeScript imports use `.js` extensions. TypeScript **6.0.3** and NestJS **12.1.3** retain the compatibility decisions from PR-00.

Set `NODE_ENV=production` explicitly for production runs. Both Swagger UI (`/docs`, including assets) and its OpenAPI document (`/docs-json`) are absent by default in production. Set `SWAGGER_ENABLED=true` to expose both, or `false` to disable them in any environment. YAML documentation is not exposed.

## API validation and documentation

All API routes use the explicit `/api/v1` prefix; the former unversioned root returns 404. Swagger remains outside that prefix.

```sh
curl -i http://localhost:3000/api/v1/greetings \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ivo"}'
# HTTP 200, text/plain: Hello Ivo!

curl -i http://localhost:3000/api/v1/greetings \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ivo","role":"admin"}'
# HTTP 400, built-in Nest error JSON
```

The example accepts exactly one `name` string, from 1 to 80 characters. Empty, missing, non-string and overlong names, and unknown properties, return HTTP 400. The global `StandardSchemaValidationPipe` uses the same Zod schema that Swagger reads from `@Body({ schema })`; `z.infer` supplies the TypeScript type. New validated request parameters must also declare an explicit schema on their Nest decorator. No DTO classes, schema bridge, response envelope or custom exception filter is needed. Keep successful response schemas explicit through Swagger's `standardSchema` option.

## Checks and tests

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

Use `pnpm format` to format application code and current tooling/docs. The supplied plans, ADRs and PR-00 snapshot are excluded from root formatting to preserve their contents; the compatibility spike also remains outside root lint, build and tests.

Jest runs JavaScript compiled by the pinned TypeScript compiler into `.test-dist/`, preserving ESM and Nest decorator metadata. `pnpm test` cleans/rebuilds this output first. Tests cover the environment schema, isolated startup failures, `.env` loading/precedence, HTTP payload validation, built-in errors and generated OpenAPI constraints. HTTP tests use native `fetch` against ephemeral loopback ports; servers and temporary files are cleaned up afterwards. Test environment values are synthetic and do not require a database or local `.env`. Node's `--experimental-vm-modules` is required for Jest ESM and may print an experimental warning. No ts-jest/Babel transformer is needed. Database integration/E2E infrastructure will be introduced in its own milestone.

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
- [PR-02 verification results](docs/pr-02-verification.md)
- [Browser auth transport](docs/adr/001-auth-transport.md)
- [Bearer session model](docs/adr/002-auth-session-model.md)

PR-03 adds persistence; CI/Docker follow in PR-04. Authentication and authorization remain later milestones. Optional extensions remain opt-in.
