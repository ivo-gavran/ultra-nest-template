# v1.0.0 release candidate

PR-13 is the final implementation milestone, **not release authorization**.
Independent final review and a green final-head **CI / Verify** are required
before a maintainer separately authorizes merging, publication, deployment,
a GitHub release or the `v1.0.0` Git tag. This work performs none of those
actions. The private `package.json` version is `1.0.0` so release-candidate
metadata matches the intended first release; the package stays `"private": true`
and is not published by this milestone. Creating or pushing the `v1.0.0` tag,
a GitHub release, npm publication, merge or deployment remains a separate
explicit authorization after independent final review.

## Initial gap analysis (2026-10-13)

Audited the implementation plan, AGENTS, README/environment, manifest/lockfile,
CI/Dependabot, Docker/Compose/smoke script, TypeScript/Jest/helpers, operational
and historical docs, actual production modules and installed package APIs.

1. **Verified existing capabilities:** official PostgreSQL-backed
   `RefreshTokenStore` (all six methods, constructor registration, no production
   fallback); conditional atomic consume; durable tombstones and user-first
   transaction locks; official concurrent contracts; scrypt `ln=17,r=8,p=1`
   (16-byte salt, 32-byte derived key); authentication before deny-by-default
   authorization; current database user/role; owner-scoped SQL; strict Zod
   fields; unique email/composite owner FKs; explicit migrations; secure
   cookies/Origin/CSRF/CORS; default-off Swagger and proxy trust; pre-auth rate
   limits; bounded readiness and graceful pool cleanup; optional, sanitized
   telemetry and correlated errors. Existing integration and Docker tests
   exercise these behaviors; PR-13 keeps the architecture intact.
2. **Missing release requirements:** dedicated independently runnable E2E,
   useful application coverage and thresholds, audit CI gates, build-map
   verification, clean onboarding evidence, explicit deployment/rollback and
   final-review checklist. PR-13 supplies these.
3. **Security/correctness defects:** `OBSERVABILITY_SQL_PROBE=1` registered a
   public SQL route in the production import graph. Removed the controller and
   flag handling from `src/`; an isolated `test/fixtures` entry point retains
   the embedded-literal privacy proof. Real production bootstrap and Docker
   tests set the old flag and require 404. No schema/auth architecture rewrite
   was warranted by the audit.
4. **Documentation-only issues:** README still named PR-12 and put development
   startup before database setup; Compose setup deferred migrations until after
   API startup; coverage/E2E commands, source-map operations and rollback were
   absent. Updated current guides; prior milestone reports remain historical.
5. **Non-blocking post-v1 work:** reviewed refresh/tombstone retention tooling,
   shared limiter for deployments with multiple replicas, scrypt capacity/load
   testing per deployment, optional password reset/email verification/MFA,
   last-admin recovery policy, image digest pinning and broader browser/platform
   certification. None is silently installed into core. Two moderate tooling
   audit exceptions are recorded below.

## Dependency and install-script review

Pinned Node **24.21.0**, pnpm **10.33.0**. `pnpm audit --json` against the root
committed tree on **2026-10-13** reports **2 moderate, 0 high, 0 critical**;
`pnpm audit --prod --json` reports **0 advisories**. Both paths were checked
against installed dependencies, not the audit metadata's misleading
`devDependencies: 0` summary. No runtime/library upgrades or lockfile edits
are necessary for these findings. A clean audit is advisory-database evidence,
not proof that software has no vulnerabilities.

| Package / advisory                                                                                                           | Exposure and mitigation                                                                                                                                                                                                                                                           | Decision / review                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `esbuild@0.18.20`, [GHSA-67mh-4wv8-2f99](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99), moderate | Development `drizzle-kit → @esbuild-kit/esm-loader → core-utils`; also present in the separate migration tooling image. Vulnerability requires esbuild's HTTP serve feature; this project invokes migration/config transformation only, never that server. Absent from API image. | Exception: patched esbuild starts at 0.25.0, outside the loader's declared minor range. Avoid an unverified transitive override or Drizzle major migration for an unreachable server path. Do not expose esbuild serve from tooling. Reviewed 2026-10-13; reassess by 2026-11-13 or on toolchain changes. |
| `sprintf-js@1.0.3`, [GHSA-hp3w-g68c-fv3c / CVE-2026-97058](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), moderate      | Jest/Istanbul config loading through `js-yaml → argparse`; unbounded precision in attacker-controlled format strings can throw RangeError. Repository-owned test/config tooling only; absent from API image. Treat untrusted PR code as untrusted CI execution regardless.        | Exception: audit supplies no patched release. Keep CI read-only with no application secrets; do not pass untrusted format strings. Reviewed 2026-10-13; reassess by 2026-11-13 or when a fix is available.                                                                                                |

No advisory IDs are suppressed. CI fails on all-dependency high/critical
findings and production moderate-or-higher findings; lower findings remain
visible for review. Audit registry failures fail the gate. Dependabot keeps its
existing weekly reviewed updates, immutable action pins and no automatic merge.

The unchanged `pnpm-workspace.yaml` permits build scripts only for
`@parcel/watcher` and `unrs-resolver` (development tooling), and explicitly
blocks Nest donation/Scarf telemetry/Lefthook auto-install scripts. No new
install-script approval, dependency, optional extension or registry was added.
Docker performs a separate frozen `--prod --no-optional` install. The smoke
checks inspect its physical pnpm store as well as top-level packages: no Jest,
TypeScript, Nest CLI, Drizzle Kit, esbuild, sprintf-js or Testcontainers. The
Node base image's bundled system/package utilities are unchanged. Migration
tooling stays in its own non-root target. Secrets are runtime-only; the build
context is an allowlist and omits `.env` and tests.

## Release gates and test scope

Run sequentially; each test command cleans/rebuilds `.test-dist`:

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

`test:cov` runs unit and integration suites together once with Jest V8 coverage,
including official concurrent store contracts. CI uses this instead of running
those suites twice, then runs E2E separately. Reports are local
`coverage/index.html`, `coverage/lcov.info` and `coverage/coverage-summary.json`.
Only compiled application modules are collected and remapped to TypeScript;
tests, fixtures, migrations, generated migration metadata, dependencies and
scripts do not inflate coverage. Subprocess bootstrap is behavior-tested but
its coverage is not attributed to the parent Jest process. Thresholds focus on
auth, authorization and users (95% lines/statements, 90% branches/functions),
and security (95% lines/statements, 85% branches, 90% functions). The remaining
application has 90% lines/statements/functions and 85% branches floors. The
measured baseline is about 98% lines and 94% branches; these floors leave
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

| Required scenarios | Release E2E proof                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–11               | Registration/login, bearer/guest, rotation/replay, persisted tombstone/restart, logout/repeated logout/revoked refresh, access still works then expires at original TTL                            |
| 12–16, 20          | Public profile fields/update, role/ID/hash rejection, admin search/keyset pagination, guest/user/admin default-deny, foreign profile/session isolation, promotion/demotion with same JWT           |
| 17–19              | Incorrect/correct old password, production PHC parameters, other families revoked/current retained, old/new credential login, deletion cascades/tombstones, all authentication fails after restart |
| 21, 25–27          | Real 400/401/403/404/409/413/429/pg-error 500, default limiter plus proxy spoof/chain/invalid-IP tests, safe projections/errors/logs and correlation                                               |
| 22–24              | Missing/null/foreign/lookalike Origin, native cross-site rejection, trusted/untrusted credentialed preflights, secure cookie scope/clearing                                                        |
| 28–31              | Healthy live/ready, PostgreSQL connection refusal/termination, sanitized 503/live 200, recovery in same app, barrier-controlled draining and real pool cleanup                                     |

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
  and business smoke, then roll out the runtime image. PR-13 adds no migration.
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
