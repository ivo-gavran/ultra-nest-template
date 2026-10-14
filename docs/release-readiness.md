# Release readiness and operations

Ultra Nest Template **v1.0.0** is officially released. The private package is
intended for reuse as a repository template. These gates and operational
requirements apply to ongoing maintenance and future releases. Merging,
publishing, tagging, creating a GitHub release or deploying requires separate
explicit authorization after independent review of the exact commit.

## Security baseline and operational follow-up

The released starter uses the official PostgreSQL-backed `RefreshTokenStore`
(all six methods, constructor registration, no production fallback), atomic
one-time consumption, durable tombstones and user-first transaction locks.
Concurrent store contracts exercise the real database. Password hashing uses
production scrypt `ln=17,r=8,p=1` with a 16-byte salt and 32-byte derived key.
Authentication runs before deny-by-default authorization; identity and roles
come from the current database user. Owner-scoped SQL, strict Zod fields, unique
email and composite owner FKs enforce database and transport invariants.

Migrations are explicit. Secure cookies, Origin/CSRF/CORS, default-off Swagger
and proxy trust, pre-auth rate limits, bounded readiness, graceful pool cleanup
and optional sanitized telemetry remain required. Test-only controllers and
bootstraps stay under `test/`; the former SQL probe cannot be enabled by a
production environment flag.

Reviewed follow-up work includes refresh/tombstone retention tooling, shared
limiting for multiple replicas, deployment-specific scrypt capacity/load testing,
optional password reset/email verification/MFA, last-admin recovery policy,
image digest pinning and broader browser/platform certification. These remain
explicit operational decisions or opt-in extensions. One moderate tooling audit
exception remains recorded below.

## Dependency and install-script review

Pinned Node **24.21.0**, pnpm **10.33.0**. `pnpm audit --json` against the root
committed tree on **2026-10-14** reports **1 moderate, 0 high, 0 critical**;
`pnpm audit --prod --json` reports **0 advisories**. Both paths were checked
against installed dependencies, not the audit metadata's misleading
`devDependencies: 0` summary. Removing Jest also removed the former `sprintf-js` advisory; the remaining
Drizzle tooling exposure requires no unrelated dependency upgrade. A clean audit is advisory-database evidence,
not proof that software has no vulnerabilities.

| Package / advisory                                                                                                           | Exposure and mitigation                                                                                                                                                                                                                                                           | Decision / review                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `esbuild@0.18.20`, [GHSA-67mh-4wv8-2f99](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99), moderate | Development `drizzle-kit → @esbuild-kit/esm-loader → core-utils`; also present in the separate migration tooling image. Vulnerability requires esbuild's HTTP serve feature; this project invokes migration/config transformation only, never that server. Absent from API image. | Exception: patched esbuild starts at 0.25.0, outside the loader's declared minor range. Avoid an unverified transitive override or Drizzle major migration for an unreachable server path. Do not expose esbuild serve from tooling. Reviewed 2026-10-13; reassess by 2026-11-13 or on toolchain changes. |

No advisory IDs are suppressed. CI fails on all-dependency high/critical
findings and production moderate-or-higher findings; lower findings remain
visible for review. Audit registry failures fail the gate. Dependabot keeps its
existing weekly reviewed updates, immutable action pins and no automatic merge.

The `pnpm-workspace.yaml` permits build scripts only for
`@parcel/watcher` and `unrs-resolver` (development tooling), and explicitly
blocks Nest donation/Scarf telemetry/Lefthook auto-install scripts. SWC uses its
lockfile platform binary; its network-capable postinstall fallback is blocked. Keep install-script approvals minimal and review any additions.
Docker performs a separate frozen `--prod --no-optional` install. The smoke
checks inspect its physical pnpm store as well as top-level packages: no test runner/compiler tooling,
TypeScript, Nest CLI, Drizzle Kit, esbuild, sprintf-js or Testcontainers. The
Node base image's bundled system/package utilities are unchanged. Migration
tooling stays in its own non-root target. Secrets are runtime-only; the build
context is an allowlist and omits `.env` and tests.

## Release gates and test scope

Run sequentially; startup suites share the scoped `.test-process-dist` build:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm test:cov
pnpm audit --audit-level=high
pnpm audit --prod --audit-level=moderate
pnpm build
pnpm verify:build
bash scripts/verify-compose.sh
```

`test:cov` runs unit and integration suites together once with Vitest V8 coverage,
including official concurrent store contracts. CI uses this instead of running
those suites twice, then runs E2E separately. Reports are local
`coverage/index.html`, `coverage/lcov.info` and `coverage/coverage-summary.json`.
Only application TypeScript source is collected;
tests, fixtures, migrations, generated migration metadata, dependencies and
scripts do not inflate coverage. Subprocess bootstrap is behavior-tested but
its coverage is not attributed to the parent Vitest process. Thresholds focus on
auth, authorization and users (95% lines/statements, 90% branches/functions),
and security (95% lines/statements, 85% branches, 90% functions). The global aggregate and the remaining
application each have 90% lines/statements/functions and 85% branches floors. See [testing configuration and measurement](testing.md) for the runner migration
comparison. The released Jest baseline is 97.97% lines and 93.91% branches; these floors leave
headroom without an arbitrary 100% requirement. Coverage supplements behavioral/race
proof and is not a claim of completeness.

`test/e2e/release.spec.ts` uses fresh migrated Testcontainers PostgreSQL and
real loopback HTTP, matching the repository's existing native-fetch convention.
No second HTTP/test framework was added. Each case clears only its disposable
database and gets a new app/limiter. Production scrypt, TTLs, cookie attributes,
strict schemas, Origin/CSRF, body caps and default rate budgets remain enabled.
Only the public JWT clock option is injected for deterministic expiry; proxy
cases explicitly configure trusted loopback ingress. Cookies are transported as
real HTTP headers; automatic browser cookie policy is covered by the existing
manual browser fixture, not claimed by native fetch.

| Scenarios | Release E2E proof                                                                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–11      | Registration/login, bearer/guest, rotation/replay, persisted tombstone/restart, logout/repeated logout/revoked refresh, access still works then expires at original TTL                            |
| 12–16, 20 | Public profile fields/update, role/ID/hash rejection, admin search/keyset pagination, guest/user/admin default-deny, foreign profile/session isolation, promotion/demotion with same JWT           |
| 17–19     | Incorrect/correct old password, production PHC parameters, other families revoked/current retained, old/new credential login, deletion cascades/tombstones, all authentication fails after restart |
| 21, 25–27 | Real 400/401/403/404/409/413/429/pg-error 500, default limiter plus proxy spoof/chain/invalid-IP tests, safe projections/errors/logs and correlation                                               |
| 22–24     | Missing/null/foreign/lookalike Origin, native cross-site rejection, trusted/untrusted credentialed preflights, secure cookie scope/clearing                                                        |
| 28–31     | Healthy live/ready, PostgreSQL connection refusal/termination, sanitized 503/live 200, recovery in same app, barrier-controlled draining and real pool cleanup                                     |

Separate integration tests retain multi-connection races, upgrade/rollback
transactions, package contracts and privacy exporters. Docker smoke retains
real SIGTERM/SIGINT, persisted volume recreation and OTLP unreachable-backend
checks. A SQL-only test fixture cannot be enabled by any runtime flag.

## Production deployment and rollback checklist

Before any separately authorized deployment:

- Independent final review approves the exact commit, latest **CI / Verify** is
  green, audit exceptions remain justified, and branch protection requires
  that reported check plus review (see [required checks](docker-ci.md#branch-protection--required-checks)).
- Build runtime/migration images from the same reviewed commit. Keep migrations
  explicit; do not run `push`, seed, auto-migrate or generate SQL in production.
- Provision an external PostgreSQL database with backups/PITR and test a restore
  on an isolated instance. Use separate least-privilege migration/runtime roles
  where supported. Inject encoded credentials/signing keys through the platform;
  require verified TLS for remote DB connections. Never pass secrets as build args.
- Configure same-site HTTPS ingress, exact trusted frontend origins, restricted
  direct API access and narrowly scoped proxy trust. Keep Swagger off, Secure
  cookies intact, no wildcard credentialed CORS. Budget scrypt memory and pool
  connections; choose shared throttling before using replicas.
- Record current image/commit, migration journal and recovery point. Review
  schema compatibility with old/new app versions, locking and data-loss risks.
  Execute the migration target once using the approved identity, verify journal
  and business smoke, then roll out the runtime image.
- Use live for process restarts and ready for traffic admission; allow at least
  the existing 30-second stop deadline. Validate readiness recovery, logs/error
  IDs and shutdown. Telemetry is optional; collector failure must not block
  startup or requests. Restrict access/retention for internal diagnostics.

Rollback is **not an automatic down migration**. If new code fails but the
schema is backward compatible, stop rollout and redeploy the previous known
image while keeping the applied schema. If schema/data changes are incompatible,
stop affected writes/traffic, choose a reviewed forward repair or restore the
recorded backup/PITR point into an isolated database, validate data and migration
journal, then switch the matching application/database pair. Restoring data can
lose later writes and can resurrect revoked refresh families: reconcile
revocations or rotate the signing key and invalidate all restored refresh
families before admitting traffic. Never delete migration journal rows or edit
already-applied SQL to pretend a rollback happened. Exercise this runbook on a
staging copy before a data-changing release.

Known semantics remain: refresh revocation does not immediately invalidate
access JWTs (up to 15 minutes); deleting an account and changing its role take
effect on the next database-backed authentication. Registration can reveal email
availability; strict concurrent refresh replay requires clients to serialize
refreshes. Tombstones are retained indefinitely until a safe cleanup policy is
implemented. These are explicit operational constraints, not newly introduced
release regressions.
