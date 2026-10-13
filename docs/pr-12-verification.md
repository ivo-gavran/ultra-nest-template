# PR-12 — Observability verification

Scope: PR-12 only, based on `main` at `1a94b1d`. It changes no schema, migrations, authentication or authorization, and adds no release preparation, Redis/background jobs or mandatory Sentry/OTLP infrastructure. Runtime: Node 24.21.0, pnpm 10.33.0, TypeScript 6.0.3, NestJS 12.1.3; Docker Desktop with PostgreSQL 17 Testcontainers.

## Acceptance criteria

| Criterion (plan)                                                  | Evidence                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing Sentry DSN/OTLP endpoint does not break startup           | Defaults are disabled; every existing suite and the Compose stack run without either. A refused, black-holed or nonexistent collector keeps serving and shuts down within the bound.                                |
| Intentional test exception produces trace/error evidence          | A real `DrizzleQueryError` route returns a generic 500 with one sanitized error log, one ERROR span with an exception event, and one Sentry event carrying the request/trace IDs.                                   |
| Unexpected exceptions reach monitoring once; 4xx creates no noise | The 400/401/403/404/413/429/500 matrix: exactly one completion log each; error log, span exception and Sentry event only for 500. Explicit `InternalServerErrorException`/502 reported once; deliberate 503 quiet.  |
| Sensitive request payloads and tokens are not exported            | Leak assertions over every log, span, metric and Sentry envelope (bodies, passwords, bearer/refresh tokens, emails, query strings, raw IDs, SQL params/statement text, DB password, collector header, signing key). |
| Telemetry backend never required for local startup                | The SDKs are not even imported when disabled. A local listener on the configured endpoint receives zero connections.                                                                                                |

## Design decisions and package review

Inspected the installed typings and source before use:

- **Nest 12.1.3:** `ConsoleLogger` JSON mode with the protected `getJsonLogObject`/`printAsJson`, `BaseExceptionFilter.catch` (HttpException branch never calls `handleUnknownError`), `handleUnknownError`/`isHttpError`, the Express adapter's `*path` not-found route, `mapException`, and the lifecycle order (destroy, then before-shutdown, then HTTP dispose, then module-by-module shutdown hooks).
- **`@sentry/nestjs` 11.7.0:** peer Nest `^12`, Node engine OK. Checked `NodeOptions` and `dataCollection`, the default integrations, runtime channel injection, and `SentryGlobalFilter`, which would report body-parser 4xx http-errors and was therefore not used.
- **OpenTelemetry:** api 1.9.1, SDK 2.12.0, OTLP/HTTP exporters 0.223.0, instrumentation-pg 0.75.0 and semantic-conventions 1.43.0. Checked span-processor `onEnding` (attributes are mutable on the SDK span), the default resource, OTEL env fallbacks, and that `handleConfigQuery` always sets `ATTR_DB_QUERY_TEXT` even when `enhancedDatabaseReporting` is false.
- **drizzle-orm 0.45.4:** its OTel tracer is never assigned, so it is inactive.

Outcomes of that review:

- **Instrumentation and ESM:** `@opentelemetry/instrumentation-http` was rejected because it records raw paths, query strings, client IPs, user agents and Host at span start; HTTP spans are manual instead. Sentry is errors-only, so OpenTelemetry is the single tracer. A spike against real PostgreSQL showed that `instrumentation-pg` works under ESM through `require-in-the-middle`, because pg's ESM entry loads its CommonJS client, and that importing pg before registration yields no spans. The unneeded `import-in-the-middle` package was removed again.
- **Dependencies:** added only the twelve packages in `package.json` (pinned exactly; no `sdk-trace-base`, which is transitive). `@sentry/node` 11.7 depends on `@sentry/bundler-plugins` and `oxc-parser`. Their native bindings are optional, excluded from the production image by `--no-optional`, and reachable only via bundler subpath exports that the runtime never imports. The lockfile is frozen-install clean, with no new ignored build scripts.

Full design, configuration and limitations are in the [observability guide](observability.md).

## Automated coverage

- `test/observability.spec.ts` (32 unit tests):
  - request-ID acceptance and rejection (length, spaces, newlines, JSON, emails, JWTs, arrays, joined duplicates), and ALS isolation across 50 interleaved flows;
  - message redaction (Drizzle params line, quoted input, URLs with credentials, IPv4/IPv6, JWTs, UUIDs/emails, SQL casts preserved);
  - error serialization (own properties and `detail` dropped, cause depth 2);
  - JSON logger record shape, param allowlist, non-string messages, error and stack forms, and static loggers;
  - telemetry schema defaults and 17 rejection cases without echoing values, plus `.env` loading and precedence;
  - statement-attribute key recognition and pre-export scrubbing (removes `db.query.text` / `db.statement` without content regexes; keeps safe DB metadata);
  - HttpException reporting policy (`InternalServerErrorException`/502 reported, 503 and 4xx not);
  - Sentry event scrubbing.
- `test/integration/observability.spec.ts` (13 tests, real PostgreSQL with migrations, in-memory span exporter, pull metric reader, recording Sentry transport):
  - The failure matrix: malformed JSON 400, unauthenticated 401 with a bogus bearer and query token, CSRF 403, 404 with query PII, 413, 429, and a real DrizzleQueryError 500. Each has the correlation header and a safe body, exactly one completion log (route template or none), and error log, span exception and Sentry only for 500. The Sentry tags equal the log's request and trace IDs.
  - Explicit `InternalServerErrorException` and 502: Nest response bodies preserved, one failure log/Sentry/span exception each, ERROR span status, no stacks. Deliberate 503: response preserved, no Sentry or exception event.
  - Spans: names, kinds, attribute allowlist, no status messages, and only `service.name`/`deployment.environment.name` in the resource. The leak scan covers everything.
  - 25 concurrent requests with distinct IDs; the ID survives JSON body parsing; invalid IDs are replaced; CORS allows and exposes `X-Request-ID`.
  - W3C `traceparent` continuation (parent IDs, log trace and span IDs); an unsampled parent is honored; baggage is ignored.
  - Client abort produces one `http.request.aborted` and never a completed record, and its span has `error.type=aborted` with no status code.
  - Health probes produce no logs, spans or metrics.
  - Histogram data points per route template and status, bounded attributes, no raw IDs.
  - Shutdown: concurrent and repeated shutdown flushes once (exporter `shutdown` called once); afterwards there is no tracer and no Sentry event.
  - Disabled telemetry: no tracer or trace IDs, and zero connections to a listener on the configured endpoint.
  - Sampling 0 exports no spans even when the inbound parent is sampled, while metrics continue.
  - Refused and never-responding collectors: requests still succeed, flush and shutdown stay within the deadline, at most one `telemetry.export.failed` warning, and no endpoint or header in the logs.
- `test/integration/observability-bootstrap.spec.ts` (1 test) spawns compiled `main.js` with OTel enabled and Sentry pointed at a local receiver. It checks:
  - pg spans are children of the route-named server spans, which continue the inbound traceparent;
  - only the two expected instrumentation scopes appear;
  - no `drizzle.*`, parameter, user, URL, client or user-agent attributes;
  - with `OBSERVABILITY_SQL_PROBE=1`, an embedded sensitive SQL literal is absent from the OTLP payload; `db.query.text` / `db.statement` are not exported; pg children retain parent links and measurable duration;
  - one metrics export on SIGTERM (interval set to 300 s) and the collector authorization header on every export;
  - zero Sentry requests;
  - JSON stdout correlated with the trace;
  - no email, password, access/refresh token, DB password, collector secret, signing key or SQL probe literal anywhere.

  A manual negative control, making `main.ts` import the app statically, fails this test with 0 pg spans.

- `scripts/verify-compose.sh`, against the production image:
  - the disabled-telemetry API's JSON logs: no secrets, emails, JWTs or raw session UUIDs; completion records with request IDs and route templates; no health records; `X-Request-ID` echo and replacement;
  - an OTel-enabled container from the same image exporting to an OTLP receiver container on the Compose network (traceparent-continued register span, pg child spans, metrics, collector header, no leaks, trace ID in logs);
  - a container whose collector does not exist still serves 200 and stops within 25 s.

  All earlier smoke coverage still passes.

Existing suites, including `security.spec.ts` (413, malformed JSON) and `sessions.spec.ts` (`auth.session.revoked`, no family IDs in logs), pass unchanged with the new middleware and filter in place.

## Local command results

| Command                          | Result                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | PASS                                                                                                           |
| `pnpm lint`                      | PASS, no warnings                                                                                              |
| `pnpm format:check`              | PASS                                                                                                           |
| `pnpm typecheck`                 | PASS                                                                                                           |
| `pnpm test`                      | PASS — 9 suites, 173 tests                                                                                     |
| `pnpm test:integration`          | PASS — 12 suites, 181 tests                                                                                    |
| `pnpm build`                     | PASS                                                                                                           |
| `bash scripts/verify-compose.sh` | PASS — including disabled-telemetry logs, OTLP export, unreachable collector; final API exit 143, PostgreSQL 0 |
| `git diff --check`               | PASS                                                                                                           |

Issues found and fixed during development:

- Zod 4 ran URL refinements after a failed URL check.
- An IPv6 mask redacted SQL casts.
- Nest's `*path` not-found route was reported as a route template.
- Sentry v11 has no `sendDefaultPii` and ignores `beforeSendTransaction` (privacy is configured through `dataCollection`; tracing is off via `tracesSampleRate: 0`).
- The error logger's first-line truncation hid multi-line config diagnostics. `main.ts` now validates the full environment first and prints value-free `KEY: rule` messages.
- Review: `instrumentation-pg` always exports `db.query.text`; a privacy `onEnding` processor now deletes statement attributes before export.
- Review: `BaseExceptionFilter.catch` never observed explicit 5xx `HttpException`s; `ObservabilityExceptionFilter.catch` now reports them once, with 503 kept quiet.

## Limitations

- Free-text messages passed to non-error logs are written as given; code must not interpolate PII into them. Only structured fields are allowlisted.
- `X-Request-ID` is client-chosen and is correlation only.
- Spans and logs are emitted in-process; shipping and retention belong to the platform.
- No Sentry process crash handlers are installed, so crashes outside requests are not reported.
- No runtime metrics, Prometheus endpoint or collector are bundled.
- Health probe successes are not traced.
- Requests rejected by Node's HTTP parser before Express (malformed request lines) are not observed.
- If an upstream system is the trust boundary for tracing, strip inbound `traceparent` there.
- `OBSERVABILITY_SQL_PROBE=1` registers a test-only SQL privacy probe route; it must never be set in Compose or production.
- Deliberate `HttpException` 5xx response bodies still carry Nest's message field (for example `InternalServerErrorException`); stacks and driver details are never added. Prefer generic messages at throw sites.

GitHub CI must be checked on the final PR commit. The PR report records the workflow status. No merge or deployment is performed.
