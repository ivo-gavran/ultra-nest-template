# PR-05 verification

Local verification completed on 2026-10-12 with Node **24.21.0**, pnpm **10.33.0**, Docker Engine **29.8.0** and Docker Compose **5.5.1**, on macOS arm64. Branch `feat/pr-05-users-persistence` starts from the fetched `origin/main` commit **8c65c62**, after PR-04 was merged.

## Changes

- `src/database/schema/users.ts`, schema index and `migrations/0001_users.sql` with Drizzle metadata: users table, UUIDs, case-insensitive unique email, password hash, nullable display name, `user`/`admin` enum and timestamps. Existing migration `0000` is unchanged.
- `src/modules/users/`: Nest module, typed repository/service, strict create/update/public Zod schemas, standalone package-backed password provider and sanitized persistence errors. `AppModule` imports the feature. All ordinary repository queries explicitly project public columns.
- `package.json`, `pnpm-lock.yaml`: only `@nestjs/authentication@0.1.1` added, matching PR-00; no additional transitive packages or optional peers installed.
- `test/users-schema.spec.ts`, `test/passwords.spec.ts`, `test/integration/users.spec.ts`, `test/integration/migrations.spec.ts`: input/password/persistence/upgrade coverage. Existing helper optionally permits the upgrade test to begin with an unmigrated container. Existing database and Compose checks now derive expected journal counts from the committed migration chain.
- `README.md`, `docs/database.md`, `docs/users.md`, this report: service contracts, validation, migration behavior, password costs, tests and scope. No environment settings changed.

## Executed checks

| Command / check                                                             | Result                                                                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                            | Exit 0; existing store selected through `npm_config_store_dir`                                 |
| `pnpm lint`                                                                 | Exit 0                                                                                         |
| `pnpm format:check`                                                         | Exit 0                                                                                         |
| `pnpm typecheck`                                                            | Exit 0                                                                                         |
| `pnpm test`                                                                 | Exit 0; **73 tests passed**, 5 suites, none skipped                                            |
| `pnpm test:integration`                                                     | Exit 0; **20 tests passed**, 3 suites, real PostgreSQL 17 through Testcontainers, none skipped |
| `pnpm build`                                                                | Exit 0                                                                                         |
| `DATABASE_URL=postgresql://localhost/example pnpm db:generate --name=users` | Exit 0; generated the committed migration without connecting to a database                     |
| `bash -n scripts/verify-compose.sh`                                         | Exit 0                                                                                         |
| `bash scripts/verify-compose.sh`                                            | Exit 0; production and migration image builds plus full Compose smoke test                     |
| `git diff --check`                                                          | Exit 0                                                                                         |

The 73 application tests include the original 50 tests, 19 users-schema cases and 4 password cases. Password tests execute real scrypt hashing and correct/incorrect verification at package production defaults. Repeated cryptographic edge cases and users integration tests use an explicit test-only `logN=10` provider override; production remains at `logN=17`.

The 20 integration tests comprise 9 existing database tests, 10 users tests and 1 migration upgrade test. Tests verify creation, normalized lookups, updates, timestamps, default/admin role constraints, duplicate create/update errors, mixed-case direct SQL conflicts, exactly one successful concurrent duplicate creation, sensitive-field omission and safe error handling. The upgrade test applies the actual original migration to an empty container, inserts existing example data, applies the new migration chain and repeats migration execution while checking that data is unchanged. Other suites apply the full chain to fresh containers. Pools and disposable containers are cleaned up.

The Compose smoke test built both image targets, ran the API as non-root with production-only dependencies, and checked HTTP 200, invalid payload 400 and production Swagger 404. Explicit migrations succeeded on an empty database and on a populated database with **two** journal entries. Example data survived PostgreSQL restart and container recreation. Shutdown returned API **143** (SIGTERM) and PostgreSQL **0**, without an API OOM kill; temporary containers/network/volume were removed.

## GitHub CI evidence

The existing PR/main **CI / Verify** workflow runs frozen installation, lint, formatting, typecheck, both test suites sequentially, production build and the Compose image/smoke verification on hosted Ubuntu. Local results above do not establish hosted CI success. The pull request and final delivery report link the completed GitHub run and record its exact commit and conclusion after GitHub reports it. No workflow permissions or branch protection settings are changed.

## Review and limitations

Reviewed the final implementation for credential exposure, mass assignment, email races, migration compatibility, unnecessary dependencies and scope violations. No production secrets, database connections or deployments were used. The new migration is additive; old SQL, compatibility spike and authentication ADRs are preserved. ESM, strict TypeScript, global validation and the existing HTTP behavior remain intact.

There are no user/authentication endpoints, tokens, sessions, authorization rules, privileged user management methods or optional services. Password changes are deliberately excluded from generic updates because the later account lifecycle milestone must handle session revocation. Service callers still need future transport-level identity/permission checks. Public timestamps are `Date` objects, and direct SQL updates must maintain `updatedAt` themselves. Scrypt memory costs are documented in the users guide.

Existing non-blocking notices remain: Jest experimental VM modules and pnpm's ignored dependency install scripts. Local container verification covers Linux arm64 through Docker Desktop; the hosted workflow provides Linux amd64 coverage. No tests were skipped or reported as passing without execution. Authentication and storage contracts are the next milestone (PR-06).
