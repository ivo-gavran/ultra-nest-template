# AGENTS.md — NestJS Starter

## Mission
Build and maintain a production-ready, reusable NestJS REST starter. Keep it simple, secure, idiomatic and testable. Follow `NESTJS_STARTER_IMPLEMENTATION_PLAN.md` in incremental PR-sized steps. Do not implement the entire plan in one pass.

## Stack and constraints
- Node.js 24 LTS, pnpm, NestJS 12.1+, strict TypeScript.
- PostgreSQL + Drizzle ORM/Kit; prefer official `@nestjs/drizzle` when compatible.
- Use Zod 4.2+ for environment and API validation; global `StandardSchemaValidationPipe`; explicit schemas on Nest request decorators. No `class-validator` DTOs.
- Prefer official `@nestjs/authentication` and `@nestjs/authorization`. Verify exported interfaces and installed package APIs before use.
- Use feature-based modular-monolith structure. Avoid speculative abstractions, generic BaseRepository, microservices, CQRS frameworks and extra infrastructure.
- Optional extensions must not be imported/installed by the core app by default.

## Architecture conventions
- Controllers handle transport; services implement workflows and business invariants; repositories encapsulate complex DB access when helpful.
- Prefer explicit typed interfaces and Zod-derived types over duplicate DTO/domain declarations.
- Drizzle migrations are version-controlled. Never auto-`push` schema to a production DB on startup.
- HTTP API errors should not expose internal exception details.
- Authorization is deny-by-default. `AuthenticationModule` must be registered before `AuthorizationModule` to preserve global guard order.
- Never authorize using user IDs from client bodies where identity must come from authenticated context.

## Security rules
- Never print or commit secrets, passwords, password hashes, access tokens, refresh tokens or user PII in logs/traces.
- Use the authentication package's scrypt password hasher and production-backed storage contracts. Use atomic one-time refresh consumption and test concurrency/races.
- For browsers, refresh token transport via HttpOnly/Secure cookie is an application-level adapter; inspect the documented API and test cookie attributes, CSRF, CORS and refresh replay.
- Access JWTs can remain valid until expiry after refresh-token revocation; document this limitation.
- Use strict input validation where unknown fields must be rejected. Reject account role/self-promotion attempts.
- Use DB constraints, not only pre-checks, for email uniqueness and referential integrity.

## Required workflow for each task
1. Inspect repository, installed dependencies and relevant tests.
2. Confirm requested PR scope, dependencies and acceptance criteria in the plan.
3. If an external API/package behavior is uncertain, inspect actual typings and official documentation; report discrepancy rather than guessing.
4. Implement minimal cohesive change and appropriate tests; favor reproducible/isolated test data.
5. Run available checks (`pnpm lint`, `pnpm typecheck`, relevant tests, `pnpm build`) and report exact results.
6. Review diff for auth bypass, security issues, migration hazards, accidental dependency additions and unrelated changes.
7. Summarize changes, file paths, commands run, blockers and next milestone.

## Test strategy
- Jest unit tests: policy decisions and business logic, with focused mocks.
- Integration tests: real PostgreSQL via Testcontainers; execute actual migrations; verify constraints/transactions.
- E2E: Supertest against initialized Nest app for auth, RBAC, users, errors, health and security.
- Run `@nestjs/authentication/testing` store contracts with concurrency enabled against PostgreSQL.
- Write regression tests before or alongside fixes. Avoid arbitrary delays and timing-dependent tests when synchronization controls are possible.

## Git and change control
- Conventional Commits required, e.g. `feat(auth): rotate refresh tokens`.
- Run formatter/ESLint on staged files through Lefthook, Commitlint on commit-msg; full checks in CI.
- Do not force-push, merge, change branch protection, delete user files, modify production secrets or deploy without explicit request.
- When blocked, stop at a safe state and explain the smallest actionable blocker.

## Done means
Acceptance criteria met; tests and types checked; README/env/docs updated for behavior changes; no secrets introduced; no speculative future work accidentally merged into core.
