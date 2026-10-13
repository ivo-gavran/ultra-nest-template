# PR-13 verification

Scope: final release-candidate implementation, based on fetched `origin/main`
at `c422d0273f544588bed12a5954b36f83221619ff` on branch
`feat/pr-13-release-candidate`. Private `package.json` version is set to
`1.0.0` for release-candidate metadata only. No merge, GitHub release, Git
tag, publication, deployment, migrations, dependency upgrades or
branch-protection changes.

See [release readiness](release-readiness.md) for the five-part audit, supply-chain
exceptions, all 31 required E2E scenarios, deployment gates and rollback runbook.
The only production code change removes the SQL privacy probe controller and
its environment-flag registration; all other implementation changes are tests,
verification tooling, CI and documentation.

## Local evidence

Node **24.21.0**, pnpm **10.33.0**, macOS arm64, Docker Engine **29.8.2**,
PostgreSQL 17 through Testcontainers and isolated Compose. No external
application/database/telemetry credentials are used.

- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `git diff --check`: exit 0.
- `pnpm test:e2e`: 8 scenario groups passed, 17.671 s; real production defaults,
  migrations, HTTP/cookies/headers, database outage/recovery and lifecycle.
- Initial `pnpm test:cov`: 21 suites / 355 tests passed, 90.479 s; 97.97%
  statements/lines, 93.91% branches, 97.86% functions. Includes all five
  official refresh-store contracts with concurrency and both production and
  isolated privacy bootstraps. Final thresholds also passed in the clean clone
  as recorded below.
- `pnpm build` and `pnpm verify:build`: exit 0; 53 production maps, relative
  source paths, no embedded source, successful internal TypeScript remapping.
- `bash -n scripts/verify-compose.sh` and `bash scripts/verify-compose.sh`:
  exit 0. Runtime and migration non-root; explicit/repeated migrations; physical
  runtime dependency store excludes tooling; maps/private SQL fixture absent
  from HTTP; secrets absent from artifacts; PostgreSQL data survives restart
  and recreation; outage/live/readiness recovery with no API restart; actual
  SIGINT/SIGTERM and drain; telemetry disabled, OTLP export and unreachable
  collector all passed. Script removed only its own project/volume.
- `pnpm audit --json`: exit 1 for two moderate tooling advisories, zero
  high/critical; `pnpm audit --prod --json`: exit 0, no advisories. Exceptions
  have exposure, mitigation and review dates; no suppressions or lockfile edits.

The first E2E compile exposed a missing exported `UserPage` type; the fixture
now derives it from the existing public Zod schema. No production workaround
was introduced. Jest's existing experimental VM-modules warning remains.

## Clean checkout verification

Cloned the committed implementation (`f4f9a29`) into a new temporary Git
checkout, with no copied `node_modules`, build output or `.env`. Installation
used the existing pnpm download cache but linked a fresh dependency tree. The
host shell initially selected Node 22 in the new directory; the engine check
correctly rejected installation. Selecting the documented Node 24.21.0/pnpm
10.33.0 toolchain resolved this without relaxing engine constraints.

| Command / check                                             | Final result                                                                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                            | Exit 0, 3.4 s; `git diff --exit-code pnpm-lock.yaml` clean                                                                                                                    |
| `pnpm lint`, `pnpm format:check`, `pnpm typecheck`          | All exit 0 in the new checkout                                                                                                                                                |
| `pnpm test`                                                 | 9 suites, 173 tests; exit 0, 3.721 s                                                                                                                                          |
| `pnpm test:integration`                                     | 12 suites, 182 tests; exit 0, 68.625 s                                                                                                                                        |
| `pnpm test:e2e`                                             | 1 suite, 8 scenario groups; exit 0, 13.893 s (second independent run)                                                                                                         |
| `pnpm test:cov`                                             | 21 suites, 355 tests; all global/scoped thresholds passed; exit 0, 90.239 s                                                                                                   |
| Coverage                                                    | 97.97% statements/lines, 93.91% branches, 97.86% functions; HTML/LCOV/JSON reports generated                                                                                  |
| `pnpm build`, `pnpm verify:build`                           | Exit 0; 53 maps and real TypeScript stack remapping                                                                                                                           |
| `.env` from example + generated signing key/isolated DB URL | Loaded by actual CLI and server; secret values never printed; temporary file removed                                                                                          |
| `pnpm db:migrate` twice                                     | Exit 0 against a fresh local, container-backed PostgreSQL database                                                                                                            |
| `pnpm start:dev`                                            | Readiness 200, registration 201, secure cookie, Swagger 200; SIGTERM completed                                                                                                |
| `NODE_ENV=production pnpm start`                            | Readiness 200, registration 201, secure cookie, Swagger 404; SIGTERM completed                                                                                                |
| `bash scripts/verify-compose.sh`                            | Full clean-checkout smoke exit 0; OTLP 15 spans / 13 pg children, metrics, unavailable collector, outage recovery, persistence and both signals; final API 143 / PostgreSQL 0 |
| Both CI audit commands                                      | Exit 0; two visible moderate tooling exceptions, no production advisories                                                                                                     |

All compilation-dependent suites ran sequentially. The existing install policy
blocked cpu-features, esbuild, protobufjs and ssh2 scripts; no new approvals were
made. Testcontainers cleanup stayed enabled; the onboarding DB and Compose
project/volume were removed. Subsequent changes only complete documentation and
make smoke-test leak assertion messages generic (never print the sensitive value
on failure); shell syntax, lint, formatting and types were rechecked.

## Final diff review and remaining release gate

Reviewed route registration/import graph, auth guard/store/owner boundaries,
strict schemas, refresh races/transactions, migration history, source-map
contents, runtime dependency store, install policy and secrets handling. No
in-memory auth fallback, auth bypass, migration change, dependency addition or
unrelated feature was introduced. The SQL-literal privacy test retains its
pg-child, parent/duration and payload assertions; the actual production main
also runs separately with the obsolete flag set and the probe absent.

No local implementation blocker remains. Existing operational limits and two
moderate tooling exceptions are classified in the release-readiness report.
Hosted **CI / Verify** on the final PR head is a separate gate recorded in the
PR/Checks tab; local results do not assert a green GitHub run. Independent final
review and explicit release authorization remain required. Private package
metadata is `1.0.0`; no merge, publish, deploy, GitHub release or `v1.0.0` Git
tag was performed.
