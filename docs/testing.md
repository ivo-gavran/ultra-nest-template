# Test infrastructure

## Commands and isolation

| Command                 | Tests                                 | Docker |
| ----------------------- | ------------------------------------- | ------ |
| `pnpm test`             | Unit/application HTTP tests only      | No     |
| `pnpm test:watch`       | Same unit selection, watching changes | No     |
| `pnpm test:integration` | PostgreSQL integration only           | Yes    |
| `pnpm test:e2e`         | Dedicated release E2E only            | Yes    |
| `pnpm test:cov`         | Unit + integration, V8 coverage       | Yes    |

`vitest.shared.ts` owns the SWC transform, Node environment, isolated forks,
disabled file parallelism, mock clearing/restoration and `sequence.hooks: 'list'`
to preserve hook ordering. Dedicated TypeScript configurations select suites
without overlap. Integration/coverage/E2E allow 120 seconds for both tests and
hooks, including container startup and teardown. No retries hide failures.
E2E replaces the ordinary setup with `test/e2e/setup.ts`, retaining production
scrypt, rate budgets and hostile SQL-probe flag assertions.

Each file gets an isolated process environment and module graph. Database tests
use disposable `postgres:17-alpine` Testcontainers, actual migrations and the
existing data reset/cleanup hooks. Official authentication storage contracts keep
`concurrent: true`; file serialization does not disable within-test database
races. Missing Docker or migration failure fails the run. Run commands
sequentially because the subprocess build directory is shared.

## Compatible transform and dependencies

Pinned development packages: Vitest and `@vitest/coverage-v8` **5.0.4**,
`@swc/core` **1.16.18**, `unplugin-swc` **2.0.0**, Vite **8.3.4**. Their engine
and peer ranges accept Node **24.21.0** and the existing types/toolchain.
Vite is an explicit required Vitest peer because pnpm automatic peer installation
is disabled. TypeScript **6.0.3**, pnpm **10.33.0** and Nest **12.1.3** stay pinned.
`jest` and `@jest/globals` are removed; application dependencies are unchanged.

Following [Nest's official Vitest/SWC recipe](https://docs.nestjs.com/recipes/swc#vitest),
SWC parses TypeScript decorators and emits legacy decorators, runtime decorator
metadata, ESM and source maps. Vite's ordinary transform is disabled. Existing
relative `.js` imports resolve to TypeScript through the SWC plugin; packages
remain native Node dependencies. Tests import Vitest APIs explicitly. There are
no module mocks or hoisting rewrites; existing spies use `vi` with the same
assertions and restoration. `pnpm typecheck` still checks all source, tests and
configurations because SWC does not typecheck.

SWC uses the platform binary pinned by the lockfile. Its postinstall script is
explicitly blocked: that script can install an unpinned WASM fallback over the
network. Install optional dependencies normally; an unavailable native binary
fails testing instead of silently fetching another compiler. No Jest VM flags or
Nest preloads are needed. Production `nest build` still uses TypeScript.

## Real Node subprocesses

Vitest's in-memory transforms cannot be executed by another Node process.
`test/setup-subprocess.ts` therefore cleans/builds `.test-process-dist/` once
before unit, integration or coverage runs, and before watch reruns. Application/fixture source changes force a unit rerun,
including files imported only by child processes. It invokes
the pinned TypeScript compiler with `tsconfig.subprocess.json`, whose only roots
are `src/main.ts` and `test/fixtures/observability-main.ts`. Their transitive
imports include the real application and isolated privacy bootstrap/controller;
ordinary test suites and tooling configurations are not compiled.

`test/startup.spec.ts` executes that production entry point and compiled
environment schema. `test/integration/observability-bootstrap.spec.ts` executes
both production and privacy-fixture entry points. Native ESM dynamic imports
preserve telemetry initialization before application/pg imports, including real
OpenTelemetry PostgreSQL spans and privacy/redaction assertions. Test-only
controllers stay outside production imports and `dist/`. Node's native
TypeScript stripping is not used for decorated modules. E2E needs no compilation.

The optional manual browser fixture has its own `tsconfig.manual.json` and
`pnpm build:test:manual`, emitting only its import graph to `.test-manual-dist/`.
Neither generated directory is committed or formatted/linted.

## Coverage floors and measurement

V8 reports application `src/**/*.ts` only, excluding specs. Reports remain text,
HTML (`coverage/index.html`), LCOV and JSON summary. Unexecuted application source
remains included; tests, fixtures and generated JavaScript never inflate coverage.
Child-process execution is behavior-tested but is not collected into the parent
coverage report, matching the previous runner.

Global minimums remain 90% statements/lines/functions and 85% branches. Separate
aggregates for auth, authorization and users require 95% statements/lines and
90% branches/functions; security requires 95% statements/lines, 85% branches
and 90% functions. These are module aggregates, not per-file requirements.

[Vitest includes scoped files in the global aggregate](https://vitest.dev/config/coverage#coverage-thresholds-glob-pattern),
where Jest subtracts them. An additional complementary source glob therefore
enforces the old global floor on the remaining application, as well as the new
all-source global floor. Scoped globs explicitly specify all four metrics because
they do not inherit global thresholds. No thresholds were lowered.

The pre-migration run on main passed **173 unit**, **182 integration**, **8 E2E**
tests and all thresholds: **97.97% statements/lines**, **93.91% branches**,
**97.86% functions**. V8-to-source remapping differs between Jest's compiled
TypeScript output and Vitest's SWC/AST mapping, so covered/total item counts need
not be identical. Compare preserved test cases and scoped floors alongside
percentages; a changed statement denominator is not evidence of removed tests.

The migrated run passes **174 unit**, **183 integration** and **8 E2E** tests
(**357** in coverage). All **22** original spec files and **198** test declarations
(including parameterized declarations and the official contract registration)
retain their assertions. Two additional regressions cover the missing-IP fallback
and real PostgreSQL credential/profile/list read failures; Vitest's first coverage
run exposed these gaps, so tests were added to meet the original floors.

Final Vitest coverage is **95.59% statements**, **91.13% branches**,
**98.75% functions**, **96.76% lines**. Jest counted 3,511 mapped lines, 3,511
statements and 674 branches; Vitest counts 711 executable lines, 772 statements
and 440 branches through its SWC/source/AST mapping. Production source and all
original test assertion bodies are unchanged; the percentage difference reflects
those different item definitions. Every original scoped floor and the complementary
remaining-source floor passes. Production JavaScript and source maps were also
verified byte-for-byte against main.
