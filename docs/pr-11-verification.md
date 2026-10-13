# PR-11 — Health and lifecycle verification

Scope: PR-11 only, based on `main` at `3a38b2e`. No schema/migration, authentication, authorization, observability or release-preparation changes. Runtime: Node 24.21.0, pnpm 10.33.0, TypeScript 6.0.3; Docker Desktop with PostgreSQL 17 Testcontainers.

## Compatibility and implementation review

Before installing, inspected Terminus 12.1.0 registry engines/peers/ESM exports and published declarations; they support the pinned stack. The only new package is `@nestjs/terminus`. Existing optional gRPC packages from development Testcontainers appear as resolved Terminus peers; production retains `--no-optional`. No optional service integrations are imported.

Inspected installed pg query/connection timeout and release behavior, Nest/Express shutdown sequencing, Drizzle cleanup/deduplication, and all named throttler policies. Uses only exported APIs. Main's shutdown-hook registration, the single ten-connection pool, Drizzle's `autoCloseConnection: true`, guard order, non-root/read-only container configuration and explicit migration workflow remain intact.

The custom indicator bounds one outstanding acquisition/query, shares concurrent results, destroys timed-out checked-out clients and discards late acquisitions without SQL. Terminus owns health aggregation, status codes, timeouts and the SIGTERM propagation delay. Results expose only status. Health does not own pool teardown. Reviewed the final diff for pool/timeout races, duplicate cleanup, public-route scope, credential exposure, accidental dependencies and migration changes.

## Automated coverage

`test/health.spec.ts` adds nine focused tests:

- Liveness has no Terminus/database dependency.
- `SELECT 1`, normal release and safe status projection.
- Acquisition/query rejection sanitization and recovery.
- Concurrent probe coalescing.
- Terminus timeout destroys the active client.
- Timed-out acquisition retains a single slot; late clients never query.
- Late acquisition rejection is handled and permits retry.
- Repeated shutdown disables new and late queries.
- Active health work is destroyed exactly once on shutdown.

`test/integration/health.spec.ts` adds six real-PostgreSQL tests using the existing Testcontainers helper and actual migrations:

- Public probes exceed a deliberately low limiter budget without 429; liveness does not acquire a client; responses preserve security/cache headers.
- Unrelated routes still enforce 401, RBAC 403, authenticated access and 429.
- Database connection refusal/termination produces sanitized 503 while liveness stays 200; restoring database availability restores readiness in the same app.
- Paused PostgreSQL stalls real queries/handshakes; concurrent/repeated probes meet the response bound and do not accumulate clients/waiters; unpause restores readiness.
- All ten connections occupied: only one health waiter survives timeout; late release executes no query; capacity recovers.
- A deterministic lifecycle barrier verifies 503 before pool closure, no new health acquisitions, in-flight HTTP/SQL completion, pool counters at zero and exactly one `end()` through Drizzle across repeated/concurrent shutdown.

`test/app.spec.ts` verifies generated OpenAPI paths, public security metadata and readiness 200/503 responses. HTTP tests follow the repository's existing native-fetch/ephemeral-server convention, without adding Supertest as another dependency.

`scripts/verify-compose.sh` additionally exercises the exact Docker HEALTHCHECK with healthy/stopped PostgreSQL, observes Docker's unhealthy status without process restart, recovers on the same API container, sends real SIGINT, and verifies readiness/liveness in the SIGTERM propagation window before a clean Compose stop. Existing auth/cookies/rotation/revocation/users/security/migration/persistence/isolation smoke coverage remains.

## Local command results

| Command                          | Result                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | PASS; existing ignored dependency-build-script warnings only                                                |
| `pnpm lint`                      | PASS, no warnings                                                                                           |
| `pnpm format:check`              | PASS                                                                                                        |
| `pnpm typecheck`                 | PASS                                                                                                        |
| `pnpm test`                      | PASS — 8 suites, 141 tests                                                                                  |
| `pnpm test:integration`          | PASS — 10 suites, 167 tests                                                                                 |
| `pnpm build`                     | PASS                                                                                                        |
| `bash scripts/verify-compose.sh` | PASS — healthy/unhealthy/recovered health status, SIGINT and SIGTERM; final API exit 143, PostgreSQL exit 0 |
| `git diff --check`               | PASS                                                                                                        |

All existing authentication/storage concurrency, secure cookie, refresh rotation/replay, session revocation, RBAC/ownership, users lifecycle, CSRF/CORS, rate/proxy/body-limit and PostgreSQL constraints/transaction tests passed. Jest retains its existing Node VM-modules warning. The full unit and integration runs execute sequentially because both rebuild `.test-dist`.

The initial integration outage fixture restarted a Docker container, which changed its ephemeral published port on Docker Desktop. It now deterministically disables connections to only the disposable test database, terminates its sessions, and restores connections. Compose still tests a stopped/restarted PostgreSQL container on its stable service address. The initial extended smoke run exposed Compose's immediate rejection of an already-unhealthy container; the script now waits for Docker's recorded recovery before `compose --wait`. These were fixture corrections, not suppressed health failures.

## Operational limitations and CI

The one-second Terminus deadline is an HTTP readiness budget, not guaranteed server-side SQL cancellation. `pg` acquisition cannot be individually canceled; one pending acquisition may live until the existing five-second pool timeout. Socket destruction bounds checked-out health work locally. Event-loop stalls can delay timers. Readiness tests database connectivity, not migrations or all business workflows.

The five-second SIGTERM delay allows routing changes to propagate; actual HTTP work then drains before Drizzle cleanup. Compose's unchanged 30-second deadline bounds total shutdown. Nest/pg cannot guarantee graceful completion for arbitrary stuck business handlers, leaked non-health clients or hanging hooks; standalone deployment needs an equivalent supervisor deadline. See [health operations](health.md).

GitHub CI must be checked on the final PR commit; local results alone do not establish CI success. The PR report records the final workflow run/status. No merge or deployment is performed.
