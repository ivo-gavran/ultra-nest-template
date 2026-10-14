# Ultra Nest Template

A modular NestJS REST starter, officially released as [**v1.0.0**](https://github.com/ivo-gavran/ultra-nest-template/releases/tag/v1.0.0). The package remains private for use as a repository template. The application exposes browser authentication and bearer-protected session administration under `/api/v1/auth`, and self-service/administrator account operations under `/api/v1/users`. Environment configuration is validated before startup. Authorization denies undeclared routes by default. Global and stricter auth rate limiting, validated proxy trust and request body caps are enforced at the HTTP edge; see the [security guide](docs/security.md).

## Requirements and installation

- Node **24.21.0 LTS**, pinned in `.nvmrc`.
- pnpm **10.33.0**, pinned through `packageManager`.
- Git for local hooks. PostgreSQL for database operations; a Docker-compatible runtime for integration tests.

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

Before starting the API, fill the empty `AUTH_SIGNING_KEY` with 32 random bytes encoded as 64 hex characters and set `AUTH_TRUSTED_ORIGINS`. The [authentication guide](docs/authentication.md#configuration-and-startup) provides a local command that writes the key without printing it. There is no development or production default signing secret.

Corepack is bundled with the selected Node release; if your Node distribution omits it, install Corepack using its official installation instructions before enabling it. `pnpm hooks:install` runs `lefthook install` and must be run once per clone; it is explicit so dependency installation also works without Git or with production-only dependencies. Dependency install scripts for Nest's optional donation message, Scarf's install telemetry and Lefthook's automatic hook installation are disabled in `pnpm-workspace.yaml`.

## Development and production build

First create a local PostgreSQL role/database matching `DATABASE_URL` (or use
the [Compose workflow](#docker-and-ci)). Then apply the committed migrations:

```sh
pnpm db:migrate
pnpm start:dev
# GET http://localhost:3000/api/v1 -> Hello World!
# Swagger UI: http://localhost:3000/docs
```

The Nest CLI compiles TypeScript and restarts on source changes. Configuration loads from `.env` in the current working directory; process environment values take precedence. Restart after changing environment settings. For example, use `PORT=3001 pnpm start:dev` on a POSIX shell.

| Variable                   | Accepted values                                    | Default                                 |
| -------------------------- | -------------------------------------------------- | --------------------------------------- |
| `NODE_ENV`                 | `development`, `test`, `production`                | `development`                           |
| `PORT`                     | Decimal integer from 1 to 65535                    | `3000`                                  |
| `DATABASE_URL`             | PostgreSQL URL with host and database              | Required                                |
| `SWAGGER_ENABLED`          | Literal `true` or `false`                          | `false` in production, otherwise `true` |
| `AUTH_SIGNING_KEY`         | 64 hex characters encoding 32 random bytes         | Required; no default                    |
| `AUTH_TRUSTED_ORIGINS`     | Comma-separated exact origins; HTTPS in production | Required; no wildcard                   |
| `RATE_LIMIT_*`             | See [security guide](docs/security.md)             | 100/60s global; 5/60s auth; 3/60s acct  |
| `TRUST_PROXY`              | `false`, hop count 1–10, or IPs/CIDRs/presets      | `false`                                 |
| `REQUEST_BODY_LIMIT_BYTES` | Integer 1024–1048576                               | `16384`                                 |
| `SENTRY_DSN`, `OTEL_*`     | See [observability guide](docs/observability.md)   | Disabled                                |

Missing `DATABASE_URL`, invalid ports or invalid flags prevent startup. Empty strings are invalid. The API creates a lazy PostgreSQL pool: connections open on the first database query, so startup alone does not verify database availability. Example credentials are for local development only. Keep `.env` untracked and inject production values through the deployment environment.

```sh
pnpm build
pnpm start
```

Production output is ESM in `dist/`, with source maps and no tests. See [internal source-map debugging](docs/observability.md#internal-source-map-debugging). Keep `package.json` beside the output so Node retains ESM mode. Local TypeScript imports use `.js` extensions. The pinned TypeScript **6.0.3** satisfies Swagger **12.0.2**'s `^5.5.0 || ^6.0.0` peer range; keep this constraint in mind when updating the toolchain. NestJS is pinned to **12.1.3**.

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
pnpm test:watch       # Unit tests; rerun on changes
pnpm test:integration # Docker required
pnpm test:e2e         # Docker; production security defaults
pnpm test:cov         # Unit + integration coverage; Docker required
pnpm build
pnpm verify:build
```

Use `pnpm format` to format code, tooling and documentation. `prettier.config.ts` preserves single quotes and trailing commas; `commitlint.config.ts` extends the Conventional Commits rules. Both configurations are included in formatting, type-aware linting and type checks. The pinned Node supports native Prettier TypeScript configuration loading without flags; Commitlint uses its bundled TypeScript loader. No extra loader or dependency is required. Prefer TypeScript for future tooling when supported cleanly by the pinned toolchain.

Vitest runs application and test TypeScript directly through SWC, preserving legacy decorators, runtime metadata and ESM. Unit tests remain independent of Docker; integration and E2E use real migrated PostgreSQL and native `fetch` against ephemeral loopback ports. Files run sequentially in isolated Node forks, with hooks in registration order and automatic mock restoration. Startup and telemetry tests still execute real Node subprocesses: global setup compiles only their entry points and imports with the pinned TypeScript compiler into `.test-process-dist/`, also rebuilding on watch reruns. Production compilation remains unchanged. See [test configuration, subprocesses and coverage](docs/testing.md).

## PostgreSQL and migrations

Create a local PostgreSQL database and set `DATABASE_URL` in `.env`. The example URL expects database `app` and a local development role `app`; replace it with your own setup. No database, role or schema is created automatically by the API.

```sh
pnpm db:migrate                         # Apply committed migrations
pnpm db:generate --name=describe_change # Generate SQL after editing a schema
```

Review generated SQL and commit it together with `migrations/meta/`. Apply migrations explicitly before running code that needs the new schema. Startup never runs migrations or pushes a schema. `example_records` is a demonstration table, with no HTTP CRUD endpoint. See the [database guide](docs/database.md) for schema organization, DI, shutdown and the production migration procedure.

With Docker Desktop (or another supported container runtime) running:

```sh
docker info
pnpm test:integration
```

This command starts disposable `postgres:17-alpine` containers, applies the actual `pnpm db:migrate` command and tests inserts, queries, constraints, transaction commit/rollback, repeat migrations and pool shutdown. Users tests cover normalized email uniqueness, concurrent duplicates, safe public models and upgrades from the pre-users schema with existing data. Each suite has a new database; records are cleared between tests, and pools/containers are closed afterwards. The first run needs network access to pull images. It never uses the development `DATABASE_URL`. Missing Docker or a failed migration makes the command fail; database tests are not silently skipped. `pnpm test` remains the independent, database-free application suite, including strict user schemas and real scrypt hashing/verification. Run test commands sequentially; startup suites share `.test-process-dist/`, and database suites manage disposable containers. `pnpm test:e2e` is the isolated release lifecycle suite; `pnpm test:cov` runs unit + integration with V8 reports under `coverage/`. See [release gates and scope](docs/release-readiness.md#release-gates-and-test-scope).

## Users API and persistence

Import `UsersModule` in a consuming feature to inject `UsersService` and `PasswordsService`. The service supports create, lookup by UUID/email and updates to email/display name. It validates strict Zod inputs, normalizes email, hashes passwords with the pinned `@nestjs/authentication` scrypt implementation and returns only explicitly selected public fields. PostgreSQL enforces email uniqueness through an index on `lower(email)`, including concurrent requests.

Run `pnpm db:migrate` before using this feature. Migration `0001_users.sql` adds the users table and role enum without altering the existing example table. Users persistence uses the existing `DATABASE_URL`. See the [users guide](docs/users.md) for input rules, return types, error handling and password costs.

`GET/PATCH/DELETE /api/v1/users/me` reads, updates or deletes the verified current account. `PATCH /api/v1/users/me/password` requires current/new passwords, returns 204 and atomically revokes other refresh families while preserving only a verified usable current family. Mutations require a trusted Origin; all account responses are no-store. Self-service accepts no role or client identity. Password changes leave browser cookies untouched because a cookie may identify a different login from the bearer. Existing access JWTs can remain valid for 15 minutes after refresh revocation.

Administrators can list/search users with `GET /api/v1/users?limit=20&sort=createdAt&order=desc`, following `nextCursor` as `after`; `GET/PATCH/DELETE /api/v1/users/:id` requires `UsersPolicy.manage`. Sort columns are allowlisted (`createdAt`, `email`) with UUID tie-breaking. Only the separate admin update schema allows role changes, which take effect on the next authenticated request. Admin self-deletion/self-demotion through target-ID routes returns 409; deliberate self-deletion uses `/users/me`.

Account deletion writes tombstones and hard-deletes the user in one user-locked transaction; existing FKs cascade families and hashed refresh tokens. Tombstones remain indefinitely after deletion. Subsequent bearer/refresh authentication fails even after restart. See [contracts, concurrency and retention tradeoffs](docs/users.md).

## Authentication

`POST /api/v1/auth/register` returns 201; `/login` and `/refresh` return 200 with only `{ accessToken, expiresIn }`; `/logout` returns 204. Auth mutations require an explicit trusted `Origin`. Keep the 15-minute access JWT in browser memory and send it as a bearer token. The rotating opaque refresh token lives only in the `__Host-refresh` HttpOnly/Secure/Lax cookie, with a seven-day absolute family limit.

`GET /api/v1/auth/sessions?limit=20&after=<nextCursor>` lists only the authenticated user's login families. `DELETE /api/v1/auth/sessions/:id` revokes one owned session; `POST /api/v1/auth/logout-all` revokes all existing devices. Both mutations return 204 and require a trusted Origin plus bearer authentication. Listing uses public UUIDs, timestamps, active/expired/revoked status and a current flag from verified JWT context. New logins after logout-all are allowed; issued access JWTs may still work for up to 15 minutes. See [session administration](docs/authentication.md#session-administration).

Run `pnpm db:migrate` to add the auth tables before using these endpoints. The global authentication guard protects new routes by default and reloads the current user from PostgreSQL. The original starter routes remain intentionally public. PostgreSQL enforces one-time consumption and durable family revocation, including concurrent refresh/logout-all storage races. Access JWTs can remain usable until expiry after refresh revocation.

Use same-site HTTPS frontend/API deployments and `credentials: 'include'`. Cookie security is never disabled for local convenience. See [authentication configuration, browser behavior and lifecycle](docs/authentication.md) for exact schemas, origins, local HTTPS/localhost considerations, storage retention, operational limitations and tests.

## Authorization

The official `@nestjs/authorization@0.1.0` global guard runs after authentication. Protected routes declare typed `@Can()` policies; a missing declaration denies access, including for administrators. Public starter/auth routes retain `@Public()`. Roles come from the database-loaded current user on each request, so changing a role affects the next request without replacing the JWT.

Users and admins can manage their own profiles and sessions. Existing SQL owner predicates remain authoritative; admins do not gain access to another user's session-management routes. Administrative user endpoints explicitly require `UsersPolicy.manage`. See [policy conventions and endpoint guidance](docs/authorization.md).

## Security hardening

`SecurityModule` registers `@nestjs/throttler` before the authentication guard: 100 requests/60s per IP per handler on business routes (health probes are exempt), an additional 5/60s (5-minute block) per IP for register/login/refresh/logout, and 3/60s per IP for password changes and admin mutations. Read-only routes, session administration, profile updates and self-deletion receive only the global limiter. Users behind one IP share budgets; submitted emails and bearer identities never change throttle keys. Throttling returns generic 429 responses with `X-RateLimit-*`/`Retry-After-*` headers before any scrypt work. `TRUST_PROXY` (default `false`) strictly validates proxy hops or IP/CIDR allowlists so forwarding headers cannot spoof throttling identity; JSON and URL-encoded bodies are capped at 16 KiB (`REQUEST_BODY_LIMIT_BYTES`) with 413 responses. Native security headers, CSRF, exact-origin credentialed CORS, the `__Host-refresh` cookie and no-store auth/users responses are unchanged. Limits are per-process in memory; multi-instance shared storage is documented, not bundled. See the [security guide](docs/security.md).

## Health and lifecycle

`GET /api/v1/health/live` returns 200 without accessing PostgreSQL. `GET /api/v1/health/ready` returns 200 when PostgreSQL answers within one second, or 503 on outage, timeout or shutdown. Both are public, retain security headers and skip rate limiting. Concurrent probes share bounded database work; readiness recovers without an application restart.

SIGTERM disables readiness, gives routing five seconds to drain, then follows Nest's existing HTTP shutdown and Drizzle pool cleanup. Compose retains its 30-second outer stop deadline. Docker HEALTHCHECK uses readiness; database failure must not be used as a liveness restart trigger. See [health behavior, timeout limitations and Kubernetes examples](docs/health.md).

## Observability

Logs are one JSON object per line (Nest's JSON format plus `service`, `requestId` and, when tracing, `traceId`/`spanId`).

- **Request log:** each request produces exactly one `http.request.completed` or `http.request.aborted` record with method, route template, status and duration. Bodies, query strings, headers, cookies, IPs and PII are never logged, and successful health probes are silent.
- **Request IDs:** every response carries `X-Request-ID`. A safe inbound value (16–64 of `A-Za-z0-9_-`) is echoed, otherwise a random UUID is generated. It is a correlation value only, never identity.
- **Unexpected errors:** they keep the generic 500 body and produce one sanitized error log, one span exception and, when `SENTRY_DSN` is set, one privacy-scrubbed Sentry event. 4xx outcomes are never reported.
- **OpenTelemetry:** with `OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT`, the API exports route-named HTTP server spans with PostgreSQL child spans (no parameter values) and a bounded `http.server.request.duration` histogram over OTLP/HTTP. W3C context propagates, and sampling defaults to 10%. Telemetry is flushed once, with a bound, at shutdown.

Neither SDK loads, and no connection is opened, when telemetry is disabled. A missing or unreachable collector never affects startup or requests. See the [observability guide](docs/observability.md).

## Docker and CI

With Docker and Compose installed:

```sh
cp .env.example .env # First setup only; review local database values
# Fill AUTH_SIGNING_KEY and AUTH_TRUSTED_ORIGINS as described above.
# Start the isolated database, apply migrations, then start the API:
docker compose up --detach --wait postgres
docker compose run --build --rm migrate
docker compose up --build
```

The API responds at `http://localhost:3000/api/v1`. Compose uses production mode, with Swagger off by default; set `SWAGGER_ENABLED=true` to expose local documentation. PostgreSQL data lives in a named volume and survives `docker compose down`. Rebuild after source changes.

The multi-stage image uses Node 24.21.0, runs as a non-root user and contains production dependencies plus compiled ESM output. Migration tooling has a separate build target. See [Docker and CI instructions](docs/docker-ci.md) for environment settings, deployment migrations, persistent data, shutdown and branch protection setup.

GitHub Actions runs install, lint, format, typecheck, unit/integration coverage, dedicated E2E, dependency audits, build/source-map verification and a Docker Compose smoke test on PRs and pushes to `main`. Test suites run sequentially. Dependabot proposes weekly dependency/action/image updates without automatic merging. Required check: **Verify** from workflow **CI**; see the [required-check guidance](docs/docker-ci.md#branch-protection--required-checks).

## Git conventions

Use feature branches and Conventional Commits, for example `feat(users): add profile endpoint`. Lefthook runs ESLint and Prettier checks for staged file paths on `pre-commit`, and Commitlint on `commit-msg`. Hooks check the working copies of those files and do not auto-fix or restage them; format/fix and stage your changes explicitly. The full test suite and build are not run in a commit hook. Keep the pinned Node and pnpm on PATH when committing from a terminal or editor.

To check a message independently:

```sh
echo 'feat: add example' | pnpm exec commitlint
echo 'invalid message' | pnpm exec commitlint # must exit nonzero
```

## Documentation

### Architecture and development

- [Engineering and contribution guidance](AGENTS.md)
- [Database, migrations and schema organization](docs/database.md)
- [Browser auth transport decision](docs/adr/001-auth-transport.md)
- [Bearer session model decision](docs/adr/002-auth-session-model.md)

### API and security

- [Authentication, browser lifecycle and refresh storage](docs/authentication.md)
- [Authorization policies and ownership](docs/authorization.md)
- [Users API, persistence and password costs](docs/users.md)
- [Security controls and limitations](docs/security.md)

### Operations and verification

- [Health and shutdown lifecycle](docs/health.md)
- [Observability and internal source-map debugging](docs/observability.md)
- [Docker, CI and required checks](docs/docker-ci.md)
- [Release gates, security audit exceptions and deployment/rollback](docs/release-readiness.md)

Historical implementation plans, verification reports and the compatibility probe
remain available through Git history and the published `v1.0.0` tag. Optional
extensions remain opt-in.
