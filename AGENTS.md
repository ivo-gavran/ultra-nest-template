# AGENTS.md — NestJS Starter

## Mission

Maintain the released, reusable NestJS REST starter. Keep changes simple, secure,
idiomatic and testable, with a focused scope and explicit acceptance criteria.
Preserve the existing application behavior unless the task authorizes a change.

## Stack and development conventions

- Use the pinned Node.js 24 LTS, pnpm, NestJS and strict TypeScript toolchain.
  Keep exact versions and the committed lockfile consistent; dependency upgrades
  belong in separately scoped changes.
- Prefer TypeScript for new code and tooling when the pinned tool supports it
  cleanly. Avoid extra loaders or dependencies solely for configuration files.
  Existing JavaScript tooling need not be converted as part of unrelated work.
- Use PostgreSQL, Drizzle ORM/Kit and the official `@nestjs/drizzle` integration.
  Inspect installed APIs and official documentation before changing integrations.
- Use Zod for environment and API validation, the global
  `StandardSchemaValidationPipe` and explicit schemas on Nest request decorators.
  Derive request types with `z.infer`; do not add `class-validator` DTOs.
- Prefer official Nest capabilities and minimal dependencies. Avoid speculative
  abstractions, generic BaseRepository, microservices, CQRS frameworks and extra
  infrastructure. Optional extensions remain opt-in and are not installed or
  imported by the core app by default.

## Architecture conventions

- Preserve the existing feature-based modular-monolith folder organization.
  Features live under `src/modules/`; database schemas and DI belong under
  `src/database/`, with version-controlled SQL under `migrations/`.
- `src/config/` owns environment schemas, validation and configuration loading.
  Application initialization and HTTP setup belong to the bootstrap layer:
  `src/main.ts`, `src/bootstrap.ts` and `src/configure-application.ts`. Preserve
  telemetry initialization before dynamic application imports.
- Controllers handle transport; services implement workflows and business
  invariants; repositories encapsulate complex database access when helpful.
  Prefer explicit typed interfaces and Zod-derived types over duplicate models.
- Use typed validated configuration rather than reparsing raw environment values.
  Keep Swagger schemas consistent with request validation and safe responses.
- Never auto-push or auto-migrate a production database on application startup.
  Review generated SQL and commit migration metadata together. Do not edit
  already-applied migrations; review upgrade, locking and rollback implications.
- Keep HTTP errors generic and free of internal exception details, SQL and values.

## Authentication, authorization and security

- Use the official `@nestjs/authentication` and `@nestjs/authorization` public
  contracts. Verify exported interfaces and installed package behavior before use.
- Authorization is deny-by-default. Register `AuthenticationModule` before
  `AuthorizationModule` to preserve global guard order. Keep the security/rate
  guard before authentication. Declare explicit policies on protected routes and
  `@Public()` only on deliberately public routes.
- Identity comes from verified authenticated context, never client body IDs,
  cookie association or unverified claims. Roles come from the current database
  user. Enforce ownership in database predicates and reject role/self-promotion
  attempts with strict inputs.
- Use the package's scrypt hasher and PostgreSQL-backed storage contracts.
  Refresh consumption is atomic and one-time; durable family tombstones must
  prevent replay and later successor insertion from restoring a revoked login.
  Preserve user-row-first transaction locking and verified-password checks.
- Browser refresh transport is an application adapter. Preserve HttpOnly/Secure
  cookies, exact trusted Origin checks, native CSRF and credentialed CORS.
  Test cookie scope, expiry, clearing, association and refresh replay.
- Access JWTs can remain valid until expiry after refresh revocation. Document
  that limitation and retention/capacity constraints; do not weaken replay rules.
- Never print or commit secrets, passwords, password hashes, tokens or user PII
  in logs/traces. Keep response projections explicit and telemetry sanitized.
- Enforce email uniqueness and referential integrity with database constraints.
  Preserve validated proxy trust, body caps and default rate budgets. Multi-replica
  deployments need a reviewed shared limiter; the default limiter is per process.

## Required workflow

1. Inspect the repository, pinned dependencies, relevant documentation and tests.
2. Confirm the task's scope, dependencies and acceptance criteria. Implement one
   minimal cohesive change without speculative future work.
3. Inspect actual typings and official documentation for uncertain package APIs;
   report discrepancies instead of guessing.
4. Write appropriate regression tests before or alongside behavior changes.
   Use isolated, reproducible test data and synchronization instead of delays.
5. Run lint, format checks, typecheck, relevant tests and build; report exact
   results and any environment blockers. Run the full CI gates for release work.
6. Review the diff for auth bypass, sensitive data, migration hazards, dependency
   additions, runtime changes and unrelated edits.
7. Update README/environment/guides for behavior changes and summarize file paths,
   commands, results and remaining limitations.

## Testing and CI

- Vitest unit tests cover policy decisions and business logic with focused mocks.
- Integration tests use real PostgreSQL through Testcontainers, actual migrations,
  constraints, transactions, pooled-connection races and restart persistence.
- E2E initializes Nest and exercises real loopback HTTP with the existing native
  fetch convention. Cover auth, RBAC, users, errors, health and security.
- Run every `@nestjs/authentication/testing` refresh-store contract with concurrency
  enabled against PostgreSQL. In-memory tests cannot establish production safety.
- Run `test`, `test:integration`, `test:e2e` and `test:cov` sequentially; startup
  suites share `.test-process-dist`. CI runs unit + integration once through
  `test:cov`, then `test:e2e`. Preserve V8 scoped and remaining-source coverage
  thresholds, SWC decorator metadata, isolated forks and sequential file execution.
  Only real subprocess entry points/imports use the scoped TypeScript build.
- Release E2E retains production scrypt, default rate budgets, real migrations and
  security modules. Test-only controllers/bootstraps stay under `test/`, never
  behind production environment flags.
- Keep CI's frozen install, lint, formatting, types, coverage, E2E, audits,
  `pnpm build`, `pnpm verify:build` and `scripts/verify-compose.sh` gates enabled.
  Record reviewed audit exceptions with exposure and review dates in
  `docs/release-readiness.md`. Docker/build/runtime changes need Docker smoke.

## Git and change control

- Use feature branches and Conventional Commits, such as
  `feat(auth): rotate refresh tokens`.
- Lefthook checks staged file paths with ESLint/Prettier on pre-commit and
  Commitlint on commit-msg; full checks run in CI. Format/fix and stage explicitly.
- Do not force-push, merge, publish, tag, create releases, deploy, change repository
  settings/branch protection, delete user files or modify production secrets
  without explicit authorization. A cleanup request authorizes only its scoped
  historical-artifact removals.
- Follow the deployment and rollback runbook in `docs/release-readiness.md` for
  separately authorized releases/deployments; passing checks is not authorization.
- When blocked, leave a safe state and explain the smallest actionable blocker.

## Done means

Acceptance criteria met; tests, types and applicable CI gates checked; current
behavior documented; no secrets, unrelated changes or speculative core additions.
