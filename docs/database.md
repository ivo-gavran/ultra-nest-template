# Database and migrations

The application uses these pinned versions: `@nestjs/drizzle` 0.0.2, `drizzle-orm` 0.45.4, `drizzle-kit` 0.31.11 and `pg` 8.23.1. Tests use `@testcontainers/postgresql` 12.2.0 and PostgreSQL 17 via `postgres:17-alpine`.

## Local setup

Install PostgreSQL locally or use an existing development instance. Create a development role/database using your normal PostgreSQL administration tooling and put its connection URL in an untracked `.env`. `.env.example` supplies illustrative local credentials only; the application does not provision them. Alternatively, use the local PostgreSQL service in the [Docker Compose setup](docker-ci.md).

For a fresh local PostgreSQL installation, connect as its administrator with
`psql -d postgres` (supply the appropriate `-U` administrator if needed), then:

```sql
CREATE ROLE app LOGIN;
\password app
CREATE DATABASE app OWNER app;
```

Enter a local-only password at the prompt and put the same URL-encoded value in
`DATABASE_URL` in `.env`. These commands are for a new local role/database;
do not rerun them against existing or production data. If local administrator
access is unavailable, the documented Compose workflow creates its own isolated
database and runs both API/migrations in containers without host PostgreSQL.
Compose does not publish PostgreSQL to the host; host `pnpm start:dev` needs a
separate reachable development database, not the internal `postgres` hostname.

Run all database commands from the repository root using the pinned Node/pnpm versions:

```sh
cp .env.example .env # On initial setup only; configure your database URL
pnpm db:migrate
pnpm start:dev
```

The CLI loads `.env` with Node's built-in loader, validates it with the same Zod environment schema as the API, and preserves process environment overrides. `DATABASE_URL` is required even for offline SQL generation. The API uses Nest's typed `ConfigService` and does not read a second set of database settings.

## Schema and dependency injection

Put table definitions in `src/database/schema/`, grouped by feature/domain as the application grows, and export them from `index.ts`. Both Drizzle Kit and the runtime use that entry point. The example `example_records` table contains a generated UUID, unique non-null label up to 80 characters, a nonblank CHECK constraint and a timezone-aware creation timestamp. It has no user or authentication semantics and no public database endpoint.

`users.ts` adds the users table and `user_role` enum. Email uniqueness is enforced by the `users_email_unique` index on `lower(email)`; application writes trim and lowercase the email before persistence. The feature repository explicitly projects public columns and sanitizes database failures so credential-bearing SQL parameters do not escape. See [users persistence](users.md) for the service contract.

`auth.ts` and migration `0002_authentication.sql` add token families, hashed refresh tokens and durable revocation tombstones. The family/owner foreign keys cascade on account deletion; unknown-family revocation markers deliberately have no FK. The integration upgrade test preserves existing users/credentials when applying the auth migration. See [authentication storage and retention](authentication.md#refresh-storage-and-races) for concurrency and cleanup requirements. The migration CLI validates database settings without requiring authentication secrets.

Session administration uses these three auth tables. Session listing projects only public fields, with an owner-scoped keyset and an existence check for usable tokens. Targeted revoke inserts a tombstone from an owner-filtered SELECT in one SQL statement; logout-all keeps the existing user-row locking protocol. See [session semantics](authentication.md#session-administration).

`DatabaseModule` registers a single database with the official `DrizzleModule.forRootAsync()`. Feature services can inject it directly; no base repository or query wrapper is required:

```ts
import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Database } from '../database/database.module.js';
import { exampleRecords } from '../database/schema/index.js';

@Injectable()
export class ExampleService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  list() {
    return this.db.select().from(exampleRecords);
  }
}
```

The pool has a maximum of 10 connections per application instance, a 5-second connection acquisition timeout and a 30-second idle timeout. Budget total connections across instances against PostgreSQL capacity. Query logging is disabled. The pool connects lazily: creating the Nest app is not a readiness check. The public [readiness probe](health.md) runs `SELECT 1` with a one-second HTTP deadline and at most one outstanding health acquisition/query. A timed-out acquisition retains its slot until this existing five-second pool bound or a late acquisition settles.

`autoCloseConnection: true` delegates ownership and cleanup to `@nestjs/drizzle`. `app.enableShutdownHooks()` enables the same cleanup for process termination; `app.close()` also awaits it. Release checked-out clients in `finally` blocks and finish transactions so the pool can drain. Feature services must not call `pool.end()` themselves. The health indicator disables readiness in `onModuleDestroy`, before Terminus's five-second SIGTERM propagation delay. Nest drains HTTP before Drizzle closes the pool in `onApplicationShutdown`; see [shutdown ordering and outer deadlines](health.md#shutdown-order-and-ownership).

## Migration workflow

1. Edit schema definitions and generate a named migration:

   ```sh
   pnpm db:generate --name=describe_change
   ```

2. Review the generated SQL, including constraints and possible data loss. Commit both SQL and Drizzle's snapshot/journal in `migrations/meta/`. Do not edit an already applied migration; generate a new one.
3. Run `pnpm db:migrate` against the intended database. The initial migration creates only the example table; Drizzle records completed migrations in `drizzle.__drizzle_migrations`.
4. Run `pnpm test:integration` to apply the committed migrations to a fresh PostgreSQL container and verify existing behavior.

Running migration generation does not connect to PostgreSQL. Running migration execution explicitly changes the selected database. There is no `db:push`, startup migration, automatic database reset or automatic rollback. Re-running `db:migrate` on an already migrated database preserves data and does not reapply completed migrations. `0001_users.sql` creates only the users table, enum and index. The upgrade test first applies the actual `0000` migration, inserts an example record, then applies the full migration chain twice and verifies that the existing record is preserved. Future schema upgrades need corresponding forward migrations and tests.

For production, run reviewed migrations once as a separate deployment step using an authorized migration identity and appropriate backups. Deployments must include the migration files and a migration environment with Drizzle Kit installed; Kit is a development dependency and is absent from a production-only application install. Coordinate changes for compatibility with still-running application instances. Never use the example credentials in production, disable TLS verification, or paste credential-bearing URLs into logs. No production database was accessed by this implementation.

## Containerized migrations

The runtime image excludes migration tooling. With the local Compose stack running, use `docker compose run --build --rm migrate` to apply the same committed migrations through a separate tooling image. This is an explicit step; starting or restarting the API never applies migrations. Production deployments should build the `migration` target from the same commit and run it once with externally supplied database configuration before deploying the matching runtime image. See [Docker and CI](docker-ci.md) for commands and environment details.

## Integration tests

```sh
docker info
pnpm test:integration
```

A Docker-compatible runtime must be running and accessible to the Node process. On this project, Docker Desktop on macOS was used. Start it before running tests; if `docker info` fails, correct runtime/socket access first. Testcontainers must also be able to pull PostgreSQL and its cleanup helper image on the first run. See the [official supported environments](https://node.testcontainers.org/supported-container-runtimes/) for alternate runtimes.

`test/helpers/postgres.ts` starts a fresh container with test-only credentials, runs the same `pnpm db:migrate` command used by developers, and stops the container if setup fails. The suite injects that container's URL through a validated `ConfigService` override. Tests clear only this disposable database between cases. Application shutdown closes pools before the container is stopped, including on failures. Testcontainers' resource reaper remains enabled.

Coverage includes database-generated defaults, typed relational queries, unique/not-null/length/check constraints, transaction commit and rollback, repeated migrations preserving existing rows and journal entries, and closure of a pool that has executed a real query. The ordinary application suite remains runnable without Docker. Integration failures are surfaced as failures, never converted into skipped or mocked database success.

Official API references: [Nest Drizzle integration](https://docs.nestjs.com/data/drizzle), [Testcontainers PostgreSQL module](https://node.testcontainers.org/modules/postgresql/).
