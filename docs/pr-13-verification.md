# PR-13 verification

Scope: final release-candidate implementation, based on fetched `origin/main`
on branch `feat/pr-13-release-candidate`. No merge, release, tag, publication,
deployment, migrations, dependency upgrades or branch-protection changes.

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
  isolated privacy bootstraps. Final threshold/clean-checkout verification is
  recorded below after completion.
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

## Remaining verification and review

A fresh committed checkout will verify frozen installation, documented `.env`
initialization, explicit migrations, development/production startup and each
standalone test command. Hosted CI is a separate gate; local results do not
assert a green GitHub run. Independent final review and explicit release
authorization remain required.
