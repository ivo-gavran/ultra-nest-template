# PR-03 verification

Verified on 2026-10-12 with Node **24.21.0**, pnpm **10.33.0** and Docker Desktop's Docker Engine **29.8.0**. Branch `feat/pr-03-database` was created from the latest fetched `origin/main`, **b216c0b**, after PR-02 was merged.

## Implemented behavior

- The official `@nestjs/drizzle` module supplies a schema-typed Drizzle database through Nest DI, backed by a `pg.Pool` configured using the existing typed `ConfigService`.
- Pool limits are explicit: 10 connections, 5-second connection acquisition timeout and 30-second idle timeout. The pool is lazy and query logging is disabled.
- The package owns pool shutdown through `autoCloseConnection: true`; the application enables process shutdown hooks. A real, previously used pool is verified closed after `app.close()` and rejects further queries.
- Schemas live under `src/database/schema/`. A minimal `example_records` table demonstrates generated UUID/timestamp defaults and unique, non-null, nonblank and length constraints. No database HTTP endpoint was introduced.
- `drizzle.config.ts` loads `.env` using Node's built-in loader and validates settings using the existing Zod schema. `db:generate` and `db:migrate` are explicit commands. The generated initial SQL and Drizzle snapshot/journal are committed together.
- `test:integration` runs independently from the existing application suite. It starts a disposable PostgreSQL container, applies real migrations through `pnpm db:migrate`, isolates records between cases and closes resources afterwards. Setup errors stop the container and fail the suite rather than skipping database checks.

## Commands and results

| Command / check                                                                          | Result                                                                                       |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile --offline --store-dir /private/tmp/nest-pr00-pnpm-store` | Exit 0; lockfile accepted                                                                    |
| `pnpm lint`                                                                              | Exit 0                                                                                       |
| `pnpm format:check`                                                                      | Exit 0                                                                                       |
| `pnpm typecheck`                                                                         | Exit 0                                                                                       |
| `pnpm test`                                                                              | Exit 0; **50 tests passed across 3 suites**, no failures/skips                               |
| `pnpm test:integration`                                                                  | Exit 0; **9 tests passed**, no failures/skips, against a real `postgres:17-alpine` container |
| `pnpm build`                                                                             | Exit 0                                                                                       |
| `pnpm db:generate --name=initial_example_records`                                        | Exit 0; generated the initial SQL migration                                                  |
| `pnpm db:generate` after generation                                                      | Exit 0; no schema changes detected                                                           |
| `pnpm db:migrate` against a new container                                                | Exit 0, executed by the integration helper before any database tests                         |
| `pnpm db:migrate` against the already migrated database containing a record              | Exit 0; record and migration journal preserved, checked by an integration test               |
| `pnpm list class-validator class-transformer --depth Infinity`                           | Exit 0; neither installed                                                                    |
| `git diff --check`                                                                       | Exit 0                                                                                       |
| `docker ps --filter ancestor=postgres:17-alpine --format '{{.Names}}'`                   | Exit 0; no PostgreSQL test container left running                                            |

Generation used a synthetic `DATABASE_URL=postgresql://localhost/example`; no connection is needed for generation. Migration execution used only the temporary Testcontainers URL, never a developer or production database. The pinned Node runtime was explicitly selected on PATH. Docker Desktop was initially stopped; starting the installed application made Docker available, so database tests were actually executed successfully.

The nine integration cases verify inserts/relational queries/default values, uniqueness, NOT NULL, the CHECK constraint, maximum length, successful transaction commit, full rollback on constraint failure, idempotent migration execution preserving data/history, and shutdown of a live pool. The initial migration proves an empty-to-initial-schema transition and reexecution on that existing schema; it does not claim to test future upgrades that have not been authored.

## Changed files

- `src/database/database.module.ts`, `src/app.module.ts`, `src/main.ts`: pool, DI and shutdown lifecycle.
- `src/database/schema/example-records.ts`, `src/database/schema/index.ts`: centralized schema definitions.
- `drizzle.config.ts`, `migrations/0000_initial_example_records.sql`, `migrations/meta/0000_snapshot.json`, `migrations/meta/_journal.json`: migration configuration and generated artifacts.
- `test/helpers/postgres.ts`, `test/integration/database.spec.ts`, `jest.integration.config.js`, `jest.config.js`: disposable real database tests and suite separation.
- `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `eslint.config.js`: required dependencies/scripts and typed/linted migration configuration.
- `.env.example`, `README.md`, `docs/database.md`, `docs/pr-03-verification.md`: setup, migration, test and verification documentation.

## Final review and remaining issues

Direct runtime additions are only the PR-00 pins: `@nestjs/drizzle@0.0.2`, `drizzle-orm@0.45.4` and `pg@8.23.1`. Development additions are `drizzle-kit@0.31.11`, `@types/pg@8.23.1` and `@testcontainers/postgresql@12.2.0`. Transitive additions belong to those packages. Testcontainers and migration generation tooling are not production runtime dependencies.

Reviewed the complete source/configuration/test/migration/documentation diff and dependency changes. No real secrets, destructive startup behavior, generic repositories, authentication, users, authorization, Docker Compose, CI or optional extensions were added. ESM/strict TypeScript, the PR-00 spike/report, both ADRs and original plans are preserved. Database readiness is intentionally not implied by application startup; its dedicated milestone remains PR-11.

No PR-03 blocker remains. Non-blocking tool notices: Jest's existing experimental VM-modules warning; existing `glob` and pinned Drizzle Kit's `@esbuild-kit/*` deprecation warnings; pnpm notices about blocked install scripts for Scarf, esbuild, protobufjs and optional SSH/native helpers. The current install-script policy was preserved, and generation, migrations, tests and builds passed under it. Other operating systems and remote Docker/SSH runtimes were not tested. CI and Docker packaging are the next milestone.
