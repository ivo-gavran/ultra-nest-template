# Observability

PR-12 adds structured JSON logs, request correlation, optional Sentry error reporting and optional OpenTelemetry traces/metrics. Both SDKs are disabled by default and need no external service: without `SENTRY_DSN` and with `OTEL_ENABLED=false`, the API opens no telemetry connections and loads neither SDK.

## Ownership

| Signal                      | Owner                                              | Notes                                                                    |
| --------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| Logs                        | Nest `ConsoleLogger` in JSON mode (`JsonLogger`)   | Always on; stdout/stderr only                                            |
| Request ID                  | HTTP middleware + `AsyncLocalStorage`              | Always on; `X-Request-ID` response header                                |
| Unexpected errors           | `ObservabilityExceptionFilter` (single global)     | One log, one span exception, one Sentry event                            |
| Traces, context propagation | OpenTelemetry `NodeTracerProvider` (only global)   | Manual HTTP server spans + `@opentelemetry/instrumentation-pg`           |
| Metrics                     | OpenTelemetry `MeterProvider` (deliberately local) | One manual histogram; instrumentation libraries keep a no-op meter       |
| Error events                | Sentry (`@sentry/nestjs`), errors only             | No tracing, no auto-instrumentation, no OpenTelemetry provider, no hooks |

OpenTelemetry is the only tracer. Sentry runs with `defaultIntegrations: false`, `enableOpenTelemetrySetup: false`, `enableRuntimeChannelInjection: false` and `tracesSampleRate: 0`, so it installs no module hooks, HTTP/pg/Express instrumentation, global handlers, propagator or span exporter. Sentry events carry the OpenTelemetry `trace_id`/`span_id` as tags for cross-navigation. There is no duplicate span or double export to reconcile.

## Startup order (ESM)

`src/main.ts` validates the application and telemetry environment, starts telemetry, then dynamically imports `src/bootstrap.ts` (NestJS, Express, Drizzle, pg). Instrumentation hooks modules as they load; pg imported before `registerInstrumentations` produces no database spans. Subprocess tests of compiled production `main.js` and an isolated privacy fixture, plus the Compose smoke test (the production image) assert database spans, and a manual negative control (static import) produces none.

`@opentelemetry/instrumentation-pg` patches `pg/lib/client.js` via `require-in-the-middle`. pg's ESM entry re-exports its CommonJS implementation, so no `--import`/`--experimental-loader` flag or `import-in-the-middle` hook is required on Node 24. Keep `main.ts` free of static application imports.

Invalid configuration (either schema) exits with code 1 before any SDK starts. Diagnostics list keys and rule messages only, never values: `Config validation error: OTEL_EXPORTER_OTLP_ENDPOINT: Required when OTEL_ENABLED=true`.

## Configuration

| Variable                      | Accepted values                                                     | Default               |
| ----------------------------- | ------------------------------------------------------------------- | --------------------- |
| `SENTRY_DSN`                  | Sentry DSN URL with a public key, no secret; HTTPS in production    | Unset (disabled)      |
| `OTEL_ENABLED`                | `true` or `false`                                                   | `false`               |
| `OTEL_SERVICE_NAME`           | 1–63 of `A-Z a-z 0-9 . _ -`; also the log `service` field           | `ultra-nest-template` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http(s)` base URL, no credentials/query/fragment; required when on | Unset                 |
| `OTEL_EXPORTER_OTLP_HEADERS`  | `key=value,key2=value2` (values percent-encoded), at most 16        | None                  |
| `OTEL_EXPORTER_OTLP_TIMEOUT`  | Milliseconds 1000–10000; per export and for each shutdown flush     | `5000`                |
| `OTEL_TRACES_SAMPLER_ARG`     | Decimal ratio 0–1                                                   | `0.1`                 |
| `OTEL_METRIC_EXPORT_INTERVAL` | Milliseconds 5000–300000                                            | `60000`               |

Exports use OTLP/HTTP JSON to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` and `/v1/metrics` (an OpenTelemetry Collector's port 4318, or a vendor's OTLP endpoint). Put collector credentials in `OTEL_EXPORTER_OTLP_HEADERS`, never in the URL; neither value is logged. Blank values are treated as unset. Other `OTEL_*` SDK variables (resource attributes, samplers, limits, batch settings, exporter-specific endpoints) are not part of the contract; the code passes explicit values for each. Resource attributes are only `service.name` and `deployment.environment.name` (from `NODE_ENV`): no host, process, container or user attributes.

Spans are sampled with `ParentBased(TraceIdRatio(OTEL_TRACES_SAMPLER_ARG))`. An inbound `traceparent` continues the trace, and an unsampled parent is honored, but a client cannot raise sampling above the configured ratio: sampled remote parents use the same ratio. Only W3C Trace Context is propagated. W3C baggage is neither extracted nor injected because it can carry user data.

## Logs

Every record is one JSON line in Nest's native format plus correlation:

```json
{
  "timestamp": 1791900000000,
  "level": "log",
  "service": "ultra-nest-template",
  "pid": 1,
  "context": "HTTP",
  "message": "http.request.completed",
  "requestId": "0f8fad5b-d9cb-469f-a165-70867728950e",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "method": "GET",
  "route": "/api/v1/users/:id",
  "statusCode": 200,
  "durationMs": 3.112
}
```

- `level` uses Nest names (`log`, `warn`, `error`, ...); `NEST_LOG_LEVEL` is honored by `ConsoleLogger`. `timestamp` is epoch milliseconds.
- `requestId` is present inside a request; `traceId`/`spanId` only when OpenTelemetry has an active span (including unsampled ones).
- Structured fields are an allowlist: `method`, `route`, `statusCode`, `durationMs`, plus a sanitized `error`. Other params passed to a logger are dropped, as are non-string messages. Free-text messages from non-error logs are written as given, so never interpolate request data, identifiers or PII into log messages.
- Errors are reduced to `{type, code, message, stack, cause}`. The message keeps only its first line (Drizzle appends bound parameters on the second), masks URLs, emails, JWTs, quoted literals, IP addresses and long opaque tokens/UUIDs, and is capped at 200 characters. Stacks contain only `at ...` frames. Own properties such as `DrizzleQueryError.query/params` or pg's `detail` are never written.

Events:

| Message                   | Level   | When                                                                                  |
| ------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `http.request.completed`  | `log`   | Once per response that was fully sent (`warn` for 5xx). Route omitted when unmatched. |
| `http.request.aborted`    | `warn`  | Once when the client disconnected before the response finished; no status code.       |
| `http.request.failed`     | `error` | Once per unexpected error (non-4xx, non-503 `HttpException`, or non-HTTP throw).      |
| `telemetry.export.failed` | `warn`  | OTLP export error, at most once per minute, no endpoint or error text.                |
| `auth.session.revoked`    | `log`   | Unchanged from PR-07.                                                                 |

Successful `GET /api/v1/health/live` and `/ready` probes produce no log, span or metric. Failed probes (for example readiness 503) are logged. Raw URLs, query strings, headers, cookies, bodies, client IPs and user agents are never logged.

## Request correlation

The observability middleware runs before every other middleware (IP validation, body parsing, security headers, CSRF, CORS), so 400/403/404/413 failures before routing and 401/403/429 from guards carry the same ID in logs, spans and the response header.

- Inbound `X-Request-ID` is accepted only when it matches `^[A-Za-z0-9_-]{16,64}$`. Anything else (absent, short, long, spaces, dots, `@`, repeated headers) is replaced with a random UUID. This rules out log injection, oversized values, emails and JWTs.
- The selected ID is always returned in `X-Request-ID` and exposed to CORS clients; browsers may send it (it is an allowed CORS header).
- The ID lives in `AsyncLocalStorage`, isolated per request (tested with concurrent requests and after JSON body parsing). `currentRequestId()` is for correlation only, never for identity, authorization, tenancy or rate limiting; clients can choose it.

## Errors and Sentry

The global `ObservabilityExceptionFilter` overrides Nest's `BaseExceptionFilter.catch` and `handleUnknownError`. Nest's `catch` only calls `handleUnknownError` for non-`HttpException` throws, so reporting for explicit HTTP exceptions lives in `catch`.

| Outcome                                                              | HTTP response                                                         | Report (log + span exception + Sentry)                                                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `HttpException` 4xx                                                  | Nest's existing status and body                                       | No                                                                                                                        |
| `HttpException` 503 (`ServiceUnavailableException` and peers)        | Nest's existing status and body                                       | No — deliberate dependency/capacity outcomes (readiness, sanitized persistence failures) must not create monitoring noise |
| Other `HttpException` 5xx (including `InternalServerErrorException`) | Nest's existing status and body                                       | Yes, exactly once                                                                                                         |
| Body-parser / `http-errors` client errors                            | Their status and body                                                 | No                                                                                                                        |
| Any other throw                                                      | Nest's generic `{"statusCode":500,"message":"Internal server error"}` | Yes, exactly once (unless `IntrinsicException`)                                                                           |

Reported events use a sanitized type/message, set the active span to ERROR, and never rewrite the response to expose stacks. Non-HTTP exceptions are reported only from `handleUnknownError`, so they are not double-counted when `catch` delegates to it.

Sentry is enabled exactly when `SENTRY_DSN` is set. Its privacy settings are explicit:

- Collection: `dataCollection` disables user info, cookies, headers, bodies, query params, database data and frame variables, and sets context lines to 0. `includeServerName: false`, `maxBreadcrumbs: 0`, `sendClientReports: false`.
- Integrations: only `linkedErrors` and `dedupe` (causes up to the default depth).
- `beforeSend` scrubs again at send time. It deletes request, user, extra, breadcrumbs, server name and modules, keeps only the trace context, sanitizes exception values and drops frame variables/source context. Tags are allowlisted: `service`, `request_id`, `http.route`, `http.request.method`, `trace_id`, `span_id`.

Stack frames (file, function, line) are sent; source lines are not. Sentry does not install process-level `uncaughtException`/`unhandledRejection` handlers here. Crashes outside request handling are logged by Node/Nest and are not reported to Sentry. This is a deliberate trade-off to avoid competing process handlers.

## Traces

Instead of `@opentelemetry/instrumentation-http`, HTTP server spans are created manually in the middleware. That instrumentation records raw paths, query strings, client addresses, user agents and Host-derived server addresses at span start, with no way to omit them.

- Name: `METHOD /route/template` (for example `GET /api/v1/users/:id`); just `METHOD` when unmatched (404, failures before routing). Methods outside the standard set become `_OTHER`.
- Attributes: `http.request.method`, `http.route`, `http.response.status_code`, `error.type` (`5xx` status or `aborted`). Status ERROR for 5xx.
- PostgreSQL child spans come from `instrumentation-pg` with `requireParentSpan` (no orphan pool/health spans), `ignoreConnectSpans`, `enhancedDatabaseReporting: false` (no parameter values), no SQLCommenter and no trace-context injection into SQL. Safe attributes kept after privacy scrubbing: `db.system.name`, `db.namespace`, `db.operation.name` when present, `server.address`/`port`. Parent-child links and span timing are preserved.
- The installed pg instrumentation always attaches `db.query.text` from the raw query string even when enhanced reporting is off. A privacy span processor runs in `onEnding` (before any exporter) and **removes** `db.query.text`, `db.statement`, `db.postgresql.values`, `db.connection_string` and related `db.query.parameter*` / `db.statement.*` keys by name — not by content regex. Free-text status messages are cleared the same way (pg puts raw driver errors there). pg exception events are already reduced to type and SQLSTATE by the instrumentation.
- Drizzle's own tracer is inactive in drizzle-orm 0.45.4. Tests assert that no `drizzle.*` attributes are exported.
- Span limits: 64 attributes, 2048-character values, 32 events. Batching: queue 2048, batch 512, 5 s delay, export timeout `OTEL_EXPORTER_OTLP_TIMEOUT`.

HTTP, log and Sentry privacy is applied at collection time (allowlists and redaction). SQL statement text is an exception: the instrumentation records it, then the span processor strips statement attributes before export so collectors never see them.

## Metrics

A single histogram, `http.server.request.duration` (seconds, semantic-conventions buckets), counts every non-probe request:

- Attributes: `http.request.method`, `http.route` (template, omitted when unmatched), `http.response.status_code` (absent when aborted), `error.type`.
- Request count and rate are the histogram count. Status categories derive from `http.response.status_code`.
- Cardinality is bounded by the route table, the method set and the status codes. There are no user IDs, emails, raw paths, IPs, sessions or tokens.
- Export period: `OTEL_METRIC_EXPORT_INTERVAL`, plus one final export at shutdown.

Runtime metrics are not included. No Prometheus endpoint, Grafana or collector is bundled. Point `OTEL_EXPORTER_OTLP_ENDPOINT` at whatever collector or vendor you operate.

## Shutdown

On SIGTERM, Nest 12 runs the Terminus readiness drain (5 s), then closes the HTTP server (in-flight requests finish), then runs `onApplicationShutdown` hooks: the Drizzle pool close and `ObservabilityModule`'s telemetry shutdown. Telemetry is flushed and stopped exactly once:

- Spans, metrics and Sentry are flushed in parallel, bounded by `OTEL_EXPORTER_OTLP_TIMEOUT` plus a 1 s grace, then the globals are disabled. Afterwards no spans are created or exported and no Sentry event is sent.
- Repeated or concurrent shutdown calls share the same result.
- No signal handlers are added, and pool cleanup is untouched.
- An unreachable or hanging collector cannot extend shutdown past that bound. Worst case is about 16 s, within Compose's 30 s `stop_grace_period`.

Every request served before the HTTP server closes is exported. Nest runs shutdown hooks module by module, so the pool close may wait for the bounded telemetry flush (or vice versa); neither depends on the other.

## Operating it

- Local collector: run an OpenTelemetry Collector with an OTLP/HTTP receiver, then set `OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`. Compose passes the telemetry variables through and defaults them to off.
- Production: use HTTPS endpoints and DSNs, keep `OTEL_TRACES_SAMPLER_ARG` low, and supply `SENTRY_DSN`/`OTEL_EXPORTER_OTLP_HEADERS` from your secret store.
- If an upstream gateway is the trust boundary for tracing, strip inbound `traceparent` there.
- Logs go to stdout/stderr only. Shipping, retention and access control belong to the platform.

## Tests

- `test/observability.spec.ts` covers ID validation, concurrency isolation, redaction, the logger allowlist, statement-attribute stripping, HttpException reporting policy, telemetry configuration and Sentry scrubbing.
- `test/integration/observability.spec.ts` runs against real PostgreSQL with an in-memory span exporter, a pull metric reader and a Sentry recording transport. It covers:
  - the 400/401/403/404/413/429/500 matrix, with one log each and Sentry/error log/span exception only for unexpected 500;
  - explicit `InternalServerErrorException` / 502 reported once, deliberate 503 quiet, Nest response bodies preserved, no stacks;
  - leak checks;
  - concurrency, body parsing and invalid IDs;
  - CORS exposure;
  - W3C continuation and unsampled parents;
  - aborts and quiet probes;
  - metric cardinality;
  - sampling 0;
  - disabled telemetry (no connections);
  - refused and black-holed collectors;
  - flush-once.
- `test/integration/observability-bootstrap.spec.ts` spawns compiled `main.js` with a local OTLP receiver and Sentry pointed at it. It verifies early instrumentation (pg child spans), traceparent continuation, export of spans and metrics once at SIGTERM, collector headers, no Sentry traffic or extra tracers, and no secrets in output. The separate `test/fixtures/observability-main.ts` entry point executes a query whose SQL text embeds a sensitive literal and asserts the literal and statement attributes are absent from the OTLP payload while pg children, parent links and duration remain.
- `scripts/verify-compose.sh` checks disabled-telemetry JSON logs in the production image, OTLP export from the image to a receiver on the Compose network, and an unreachable collector.

## Internal source-map debugging

`pnpm build` emits adjacent `.js.map` files in `dist`; `pnpm verify:build`
checks every map and exercises actual Node stack remapping. Maps contain
relative repository source paths and mappings, no embedded `sourcesContent`,
absolute developer paths, environment files or runtime secrets. They remain
inside the private application artifact and are not served by any HTTP route.
Do not mount `dist` as static content or publish maps to a public bucket.

For controlled internal debugging, start the same compiled artifact with
`node --enable-source-maps dist/main.js` (or inject
`NODE_OPTIONS=--enable-source-maps` through the supervisor). Node reports
TypeScript file/line locations even without the source tree in the container.
Use a private checkout of the **exact image commit** to inspect those lines.
Default `pnpm start` keeps compiled stacks; enabling remapping is optional.
Never expose a debugger port to public ingress. No automatic upload or public
source-map hosting is configured.

Public 500 errors remain generic and contain no stack/source paths; use the
response `X-Request-ID` to locate restricted JSON logs and, when configured,
Sentry trace/request tags. Sentry retains safe frame locations, drops local
variables/source context, and does not automatically upload these maps. OTel
keeps safe type/message correlation without SQL text. Free-text diagnostics
are not a license to log credentials or PII.

The SQL privacy probe now exists only under `test/fixtures`, outside production
compilation and Docker context. `OBSERVABILITY_SQL_PROBE` is no longer a runtime
setting; setting it cannot register a route, including in production. The
embedded SQL literal/export privacy assertions remain enabled in the isolated
fixture; real production bootstrap separately asserts 404 with the old flag.
