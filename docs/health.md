# Health and lifecycle

## Probe contract

Both routes are public, carry the usual security headers and disable HTTP caching. `@Public()` exempts only this controller from authentication/authorization. `@SkipThrottle({ global: true, auth: true, account: true })` explicitly skips all three configured rate-limit policies. Other controllers retain their existing guards, policy order and limits. Swagger documents these routes when enabled.

- `GET /api/v1/health/live`: HTTP 200 with `{"status":"ok"}` when the process can serve HTTP. No database acquisition/query, external dependency or Terminus shutdown check. PostgreSQL outages do not change liveness.
- `GET /api/v1/health/ready`: Terminus HTTP 200 when PostgreSQL answers `SELECT 1` within the shared 1,000 ms acquisition/query deadline. HTTP 503 on connection rejection, query failure, timeout, pending cleanup after timeout, or shutdown. Healthy probes can run before migrations: this checks connectivity, not schema/application correctness.

Healthy readiness:

```json
{
  "status": "ok",
  "info": { "postgres": { "status": "up" } },
  "error": {},
  "details": { "postgres": { "status": "up" } }
}
```

Unhealthy readiness has `status: "error"`, empty `info`, and only `postgres: { status: "down" }` in `error` and `details`. During Terminus's shutdown phase the top-level status becomes `shutting_down`; the earlier module-destroy phase can return `error`. Both return 503. No SQL, database URL, driver message, timing diagnostics, credential or stack is returned. Terminus probe logging is disabled; health checks do not log driver failures. Existing application/Drizzle logging outside these checks is unchanged.

## Timeout, capacity and recovery

`PostgresHealthIndicator` injects the existing Drizzle database and uses its `$client` pool. The pool remains capped at ten connections, with its existing five-second `connectionTimeoutMillis`. No extra connection pool, database session settings, migrations or startup queries are introduced.

The implementation uses Terminus's public `HealthIndicatorService`, `attempt().withTimeout(1000)`, `up()/down()` and `HealthCheckService` APIs. It consumes the timeout signal instead of merely racing an arbitrary Promise:

1. Concurrent requests share one in-flight probe result. At most one acquisition/query is outstanding per application instance.
2. A checked-out probe client is released normally after success. On timeout, shutdown or failure, `client.release(true)` discards it. For the installed non-pipelined `pg` client, ending a connection with an active query destroys its socket and rejects the query. The client is never returned to the idle pool with unfinished work.
3. `pg.Pool.connect()` has no public per-call cancellation signal. If acquisition exceeds the one-second readiness deadline, the HTTP request returns 503, but the acquisition slot stays occupied until the pool's five-second acquisition bound or a late connection settles. Further probes fail immediately instead of creating more waiters. A late client is discarded without executing SQL.
4. Results are not cached after the operation settles. A subsequent successful acquisition/query restores readiness without restarting the process.

`pg`'s `query_timeout` is a client-side read timeout, not a reliable PostgreSQL cancellation mechanism. We do not use it as cancellation and do not access pg internals or open another connection to issue a cancel request. Destroying the socket bounds local resources; it does **not** guarantee the database backend has immediately stopped work during a network partition. The actual probe is only `SELECT 1`. A stalled/overloaded Node event loop can delay any timer and HTTP response. One-second timeouts are not real-time guarantees.

## Shutdown order and ownership

The existing `app.enableShutdownHooks()` remains the signal entry point for SIGTERM/SIGINT. There are no added process signal listeners or calls to `pool.end()` in the health feature.

1. `PostgresHealthIndicator.onModuleDestroy()` irreversibly disables readiness and aborts its active probe. Repeated calls are safe. Late acquisitions cannot issue new queries.
2. Terminus's `beforeApplicationShutdown` hook marks its result `shutting_down`. On **SIGTERM**, the configured `gracefulShutdownTimeoutMs: 5000` keeps HTTP available for five seconds so an orchestrator can observe 503 and remove the instance. SIGINT and ordinary `app.close()` do not apply this delay. Readiness remains disabled regardless of signal.
3. Nest's Express adapter stops accepting connections and waits for in-flight HTTP requests. Their existing database access remains available during drain. Clients should not send new business traffic after the instance becomes unready; the five-second propagation window itself does not reject business requests.
4. The official Drizzle module's `onApplicationShutdown()` invokes `pg.Pool.end()` after HTTP disposal. Its existing per-client cleanup tracking prevents duplicate pool closure, including repeated/concurrent `app.close()` calls. The health module never closes the pool.

Tests hold a lifecycle barrier and an in-flight HTTP request to prove this order and query suppression, without depending on racing a request against server closure. Container smoke tests additionally exercise actual SIGINT and SIGTERM delivery.

Compose's existing **30-second stop grace period** is the outer deadline, including the five-second propagation window. Healthy shutdown must finish before that deadline; smoke tests reject forced-kill exit codes. Nest/pg themselves do not impose a global shutdown deadline for arbitrary application work: a stuck business handler, leaked non-health client or hanging lifecycle hook can still need the supervisor's final kill. Run standalone Node under a supervisor with an equivalent deadline. This PR bounds health resources and preserves the existing application drain contract; it does not promise every future business operation can be interrupted safely.

## Docker and Kubernetes examples

The image's `HEALTHCHECK` now calls readiness, every ten seconds with three failures required. Its HTTP budget is two seconds and Docker's command timeout is three seconds, allowing the one-second database deadline plus HTTP/process overhead. A PostgreSQL outage makes the container **unhealthy**, while liveness stays 200. Docker/Compose health status alone does not restart a container. Do not configure an external auto-restart tool to restart the process solely because readiness fails.

For Kubernetes, configure separate probes rather than treating the image health check as liveness. Example pod fragment (no Kubernetes dependency is required by this project):

```yaml
spec:
  terminationGracePeriodSeconds: 30
  containers:
    - name: api
      image: your-registry/ultra-nest-template:your-tag
      ports:
        - containerPort: 3000
      livenessProbe:
        httpGet:
          path: /api/v1/health/live
          port: 3000
        periodSeconds: 10
        timeoutSeconds: 2
        failureThreshold: 3
      readinessProbe:
        httpGet:
          path: /api/v1/health/ready
          port: 3000
        periodSeconds: 2
        timeoutSeconds: 2
        failureThreshold: 1
```

The readiness interval is shorter than the five-second SIGTERM delay. Tune probe frequency, propagation allowances and the outer grace deadline to the platform's actual routing behavior. Kubernetes also removes terminating pods from endpoints; the delay allows that change to propagate. Keep migration execution a separate deployment step. Health endpoints intentionally disclose only coarse process/database availability; restrict network ingress at the platform where appropriate.

## Verified package APIs

Pinned `@nestjs/terminus` **12.1.0** declares Nest common/core `^11 || ^12`, compatible Swagger/RxJS/reflect-metadata peers, Node `^20.19 || ^22.12 || >=24`, ESM exports and TypeScript declarations compatible with this repository's TypeScript 6.0.3/Node16 module resolution. Registry metadata and tarball declarations were inspected before installation; compiled ESM tests/build verify the installed artifact. No optional ORM/HTTP/microservice integrations are added. The lockfile adds only Terminus; its optional gRPC peers bind to packages already present through development-only Testcontainers. The production image retains `--no-optional`, excluding those optional peers.

Source/API inspection also covered `pg` 8.23.1, `pg-pool` 3.14.0, `@nestjs/drizzle` 0.0.2, Nest 12.1.3 and throttler 6.7.1. References: [Nest health checks](https://docs.nestjs.com/reliability/terminus), [Nest lifecycle](https://docs.nestjs.com/fundamentals/lifecycle-events), [pg pool acquisition/release](https://node-postgres.com/apis/pool), [pg client configuration](https://node-postgres.com/apis/client).
