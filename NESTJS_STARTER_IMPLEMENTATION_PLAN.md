# NestJS Starter — Implementation Plan v1.0

**Status:** Architecture agreed; implementation not started  
**Prepared:** 2026-10-12  
**Goal:** A reusable, production-ready NestJS REST starter with a small, secure default footprint and documented optional extensions.

## 0. Scope and principles

- Build a **modular monolith**, organized by feature. No microservices, CQRS framework, generic repositories everywhere, or unnecessary architecture layers.
- Favor official NestJS capabilities and conventional APIs; introduce custom code only where it solves a specific need.
- Finish one independently reviewable pull request at a time. Avoid mixing unrelated setup changes.
- Before adopting a package/API, inspect its **installed version**, TypeScript declarations and current official docs. Do not invent or assume an API.
- Every milestone leaves the project compiling, tested where applicable, and documented.
- Secrets, passwords, access tokens, refresh tokens, and sensitive request bodies must never be logged.
- Optional extensions must not add runtime dependencies or infrastructure requirements to the default application.

## 1. Agreed technology decisions

| Area | Choice |
| --- | --- |
| Runtime | Node.js **24 LTS** (pin exact patch through a version manager/CI image; refresh intentionally) |
| Framework | NestJS **12.1+**, Express adapter unless tests identify a reason to change |
| Language | TypeScript, `strict: true` |
| Package manager | pnpm with committed lockfile; Corepack packageManager field |
| Persistence | PostgreSQL, `drizzle-orm`, `drizzle-kit`, `pg`, `@nestjs/drizzle` |
| Configuration | `@nestjs/config` + Zod Standard Schema, validated at startup |
| Request validation | Zod **4.2+** + global `StandardSchemaValidationPipe`; explicit schema on `@Body`, `@Query`, `@Param` |
| API documentation | `@nestjs/swagger`, generated/verified from Zod Standard Schema |
| Authentication | `@nestjs/authentication`; short-lived JWT access tokens, rotating opaque refresh tokens, PostgreSQL-backed auth storage, built-in scrypt hasher |
| Authorization | `@nestjs/authorization`, `@Can` policies, `user`/`admin`, deny by default, ownership checks |
| Security | Native Nest security headers and CSRF, `enableCors`, `@nestjs/throttler`, request-size controls |
| Logging | Nest structured JSON logger initially; request correlation/redaction; Pino only if needed |
| Health | `@nestjs/terminus`, `/health/live` + `/health/ready`, custom PostgreSQL readiness indicator |
| Observability | Sentry errors + OpenTelemetry tracing/metrics, enabled only when configured |
| Tests | Jest, `@nestjs/testing`, Supertest, Testcontainers PostgreSQL, real migrations |
| Tooling | ESLint, Prettier, Lefthook, Commitlint/Conventional Commits, `.editorconfig` |
| Delivery | Multi-stage Dockerfile, Docker Compose (development), GitHub Actions, Dependabot, branch protection |

**Deliberately out of scope for core v1:** OAuth/social login, MFA, password-reset email, multi-tenancy, GraphQL, WebSockets, scheduled jobs, event brokers, Redis and S3 at startup. Email verification and password reset can be added as optional follow-up auth features when the email extension is enabled.

### Two integration details to validate early

1. **Browser token transport:** The official authentication tutorial uses session cookies for browser sessions and bearer access/refresh tokens for other clients. Our agreed browser approach is access token in memory plus an `HttpOnly`/`Secure` refresh cookie. The app must implement its own thin cookie transport adapter on top of `TokenService` and verify CSRF, cross-origin credentials, cookie attributes and no refresh-token leakage in JSON. Do not mistake this for a built-in cookie-refresh feature.
2. **Session management:** `SessionService` handles server-side sessions, whereas refresh-token families represent bearer-token logins. Prove how list/revoke individual bearer login families can be supported before promising a unified `/auth/sessions` API. Prefer documented public APIs or a minimal persisted session/device read model; never reach into undocumented package internals. Record the result as ADR-002 before the auth PR is accepted.

## 2. Proposed folder structure

```text
src/
  main.ts
  app.module.ts
  config/
    env.schema.ts
    app.config.ts
  database/
    database.module.ts
    schema/
    seed/
  common/
    filters/
    interceptors/
    decorators/
  infrastructure/
    logging/
    observability/
  modules/
    auth/
      schemas/
      providers/
      storage/
      auth.controller.ts
      auth.module.ts
    authorization/
      policies/
      authorization.module.ts
    users/
      schemas/
      users.controller.ts
      users.service.ts
      users.repository.ts
      users.module.ts
    health/
      indicators/
      health.controller.ts
      health.module.ts
migrations/
test/
  helpers/
  integration/
  e2e/
extensions/
  caching/
  jobs/
  email/
  storage/
  events/
  scheduling/
  messaging/
docs/
  adr/
  extensions/
.github/
  workflows/
  dependabot.yml
AGENTS.md
README.md
.env.example
Dockerfile
docker-compose.yml
dizzle.config.ts
lefthook.yml
```

`extensions/` is documentation and standalone example packages or files, **not** automatically imported into the Nest app.

## 3. Implementation backlog: 14 PR-sized milestones

### PR-00 — Compatibility spike and architecture records

**Implement:** Verify actual package versions and peer dependencies; run minimal compiling examples for `@nestjs/drizzle`, Zod Standard Schema in `@nestjs/config`, `StandardSchemaValidationPipe`, Swagger generation, `@nestjs/authentication`, `@nestjs/authorization`, native CSRF/security headers. Decide the browser refresh-cookie and bearer session-listing approaches; record ADR-001 (auth transport) and ADR-002 (session model).

**Acceptance:** `pnpm install` resolves dependencies; minimal smoke example builds; no invented APIs; ADRs explain remaining tradeoffs, plus any package fallback. Only proceed after auth storage/guard approach is viable.

### PR-01 — Bootstrap, project conventions and developer tooling

**Implement:** NestJS starter, pnpm, Node LTS pin, strict TypeScript, ESLint, Prettier, `.editorconfig`, `.gitignore`, `.env.example`, README, AGENTS.md, conventional Commitlint config, Lefthook `pre-commit`/`commit-msg`. Use fast staged-file checks only; do not run the full suite inside a commit hook.

**Acceptance:** Fresh clone installs with `pnpm install --frozen-lockfile`, starts with `pnpm start:dev`, lints, typechecks and builds. Invalid commit messages are rejected locally. Document initial hook installation (`pnpm exec lefthook install`) or setup script.

### PR-02 — Configuration, validation, HTTP conventions and Swagger

**Implement:** Central Zod environment schema with startup failure on missing/invalid required values. Global `StandardSchemaValidationPipe`, a strict Zod request schema (`z.strictObject` where unknown fields should be rejected), API versioning or explicit `/api/v1` prefix, Swagger from Zod request schemas, built-in exception handling first. Add a representative validation endpoint or test-only controller.

**Acceptance:** Missing `DATABASE_URL` prevents startup; invalid request returns 400; unknown fields rejected where strict; Swagger schema matches actual request validation. No `class-validator`/`class-transformer` DTO stack.

### PR-03 — PostgreSQL, Drizzle, migrations and test DB

**Implement:** `@nestjs/drizzle` module (or a small DI module only if official integration has a demonstrated incompatibility), `pg` pool, Drizzle schemas, `drizzle-kit` generate/migrate scripts, first migration, seed only for development, DB cleanup on shutdown. Prepare Testcontainers helper applying **real migrations**.

**Acceptance:** `pnpm db:migrate` works on empty and existing DB; migration run is reproducible; simple repository integration test hits a real PostgreSQL container; app closes connections cleanly. No automatic destructive schema push on production startup.

### PR-04 — Local/production Docker and CI baseline

**Implement:** Docker multi-stage build, non-root runtime, image health/security basics, Compose for local PostgreSQL and API, GitHub Actions checks (lint, typecheck, unit, integration/e2e when present, build, image build), Dependabot, README workflow. Add GitHub branch protection/ruleset instructions.

**Acceptance:** `docker compose up --build` starts app plus database, test command runs in clean CI, dependency caching works, workflows fail on broken checks. Production config uses external secrets and a separately managed migration step.

### PR-05 — Users persistence, password utilities and DTO schemas

**Implement:** Users table (UUID, normalized/case-insensitive unique email, password hash, optional name, `user`/`admin`, timestamps), typed Drizzle repository, `UsersService`, create/update schemas, safe response shape, built-in `PasswordHasher` from `@nestjs/authentication`. Avoid returning or logging password hashes.

**Acceptance:** Real PostgreSQL tests cover email uniqueness regardless of case, create/find/update and sensitive-field omission. Race on duplicate email is handled by DB unique constraint, not check-then-insert.

### PR-06 — Authentication: tokens and storage contracts

**Implement:** Configure `@nestjs/authentication`; PostgreSQL-backed store contracts required by selected features; token issuance, refresh rotation, revocation, password login, register; Zod validation; clear secrets handling; 15-minute access / 7-day refresh as configurable defaults. Use official scrypt hasher; account for memory/threadpool costs in deployment docs. Implement atomic consume/update operations with `WHERE used_at IS NULL` or equivalent. Add cookie transport adapter for browsers per ADR-001.

**Acceptance:** Register/login/protected endpoint/refresh/logout work end to end; refresh replay revokes the family; two simultaneous refreshes cannot both succeed; secrets never appear in logs, request responses or stored plaintext. Run `@nestjs/authentication/testing` **store contract tests with concurrency enabled** on PostgreSQL. Browser cookie and CSRF flow verified.

### PR-07 — Authentication session administration

**Implement:** Logout-all, current session/family revocation, session listing and targeted revoke based on ADR-002. If official APIs expose cookie sessions only, make token-family session listing a separate supported read model or explicitly revise its scope; do not silently claim bearer families are covered. Document access JWT revocation limitation (valid until expiration).

**Acceptance:** User can revoke own sessions but not another user's; logout-all blocks refreshing on all devices; cookie deletion flags correct; isolated E2E tests demonstrate behavior after restart.

### PR-08 — Authorization and ownership

**Implement:** `@nestjs/authorization`, typed policies, initial `user`/`admin` permissions, `@Can` decorators, deny-by-default, resource ownership checks in application services when resource must first be loaded. **Register AuthenticationModule before AuthorizationModule** so global guards run in the correct order.

**Acceptance:** Guest 401, authenticated forbidden 403, allowed user 2xx; `user` cannot access admin endpoints or another user's resource; every new route must declare a permission/public policy. Unit tests for each policy and E2E coverage for guard order.

### PR-09 — Users API and account lifecycle

**Implement:** `/users/me` GET/PATCH/DELETE, `/users/me/password` PATCH; admin-only users listing/search/pagination/sorting + get/update/delete. Field-level Zod update schemas prevent mass assignment, especially `role`, `id`, `password_hash`. Password change revokes other refresh families; deletion cleans/revokes auth state per transaction/deletion policy. Keep auth endpoint code in AuthModule.

**Acceptance:** Non-admin cannot self-promote; stable paginated responses; changes do not expose hashes; password change invalidates previous refresh credentials; deletion follows documented retention policy and FK behavior.

### PR-10 — Security hardening

**Implement:** Native security headers, explicit CORS origin allowlist with credentials, native CSRF (Nest 12.1+), `@nestjs/throttler` global and stricter auth limits, request body size caps, secure cookie settings, proxy trust configuration, generic auth failures, sensitive logger redaction and minimal Swagger exposure in production. For multiple instances, document/enable shared limiter storage; default single-instance limiter remains in memory.

**Acceptance:** E2E verifies rejected origin, rejected unsafe cross-site POST, allowed trusted frontend, 429 for abusive requests, expected response headers and no leaked passwords/tokens. Do not assume CORS replaces CSRF.

### PR-11 — Health and lifecycle

**Implement:** `/health/live`, `/health/ready` using Terminus and a custom Drizzle `SELECT 1` probe with ~1s timeout. `enableShutdownHooks()`; readiness fails when DB unavailable and during shutdown. Avoid noisy logs for successful probes.

**Acceptance:** Live 200 with DB down; ready 503 with DB down; ready 200 after recovery; graceful stop closes DB pool and readiness transitions appropriately.

### PR-12 — Observability and operational behavior

**Implement:** Structured request logging and correlation ID, Sentry for error monitoring, OpenTelemetry for traces/metrics via optional configuration, reasonable sampling, safe attributes and exporter shutdown. Verify that unexpected exceptions reach monitoring once, while predictable 4xx responses do not create noise. Never require telemetry backend for local startup.

**Acceptance:** Missing Sentry DSN/OTLP endpoint does not break startup; an intentional test exception produces trace/error evidence in test integration or controlled exporter; sensitive request payloads and tokens are not exported.

### PR-13 — Hardening, documentation and release candidate

**Implement:** Critical E2E suite (register → login → protected route → refresh → logout; admin policies; users; 400/401/403/429; DB health); full Docker smoke on clean checkout; source maps; dependency audit; production deployment/readme checklist; `AGENTS.md` updates; examples of required GitHub checks; tag `v1.0.0` only after verification.

**Acceptance:** All CI steps green; clean clone onboarding succeeds without tacit knowledge; no real secrets in git or example fixtures; migration procedure and rollback are documented; Docker runtime uses non-root user; auth store has no in-memory production fallbacks; open issues are classified/blockers addressed.

## 4. PR dependency order

```text
PR-00 (package/API spike)
  -> PR-01 -> PR-02 -> PR-03 -> PR-04
                     -> PR-05 -> PR-06 -> PR-07
                                         -> PR-08 -> PR-09
                                         -> PR-10 -> PR-11 -> PR-12 -> PR-13
```

PR-04 can be moved later if useful, but CI should exist before significant auth work. Keep auth storage proof and contracts ahead of controllers.

## 5. Quality gates and commands

Standardize scripts in `package.json`:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm test:cov
pnpm build
pnpm db:generate
pnpm db:migrate
pnpm db:seed        # dev only
```

For each PR:

1. Inspect existing repository conventions and related docs first.
2. Summarize intended changes and acceptance criteria before coding.
3. Make the smallest cohesive change. Add/update tests with implementation.
4. Run affected tests plus lint, typecheck and build (where environment permits).
5. Review diff for secret exposure, auth bypass, migration regressions, public APIs and unnecessary abstraction.
6. Report exact commands/results and any blockers honestly; do not claim unrun tests passed.
7. Create descriptive Conventional Commit(s). Do not push or merge without explicit authorization.

### Final v1 release gate

- [ ] Clean clone onboarding works with pinned Node/pnpm and documented setup.
- [ ] `pnpm install --frozen-lockfile`, lint, typecheck, tests and build pass.
- [ ] Real PostgreSQL migrations pass from empty DB and during an upgrade.
- [ ] Authentication store passes concurrency contract tests.
- [ ] Browser cookies, CSRF, logout/revocation and token replay tested.
- [ ] Authorization default-deny and ownership tested; guard order verified.
- [ ] No password hashes, tokens or secrets in logs/responses/traces.
- [ ] Docker deployment works as non-root; health and graceful shutdown verified.
- [ ] Branch protection required CI checks documented and configured in target repo.
- [ ] README, `.env.example`, AGENTS.md, runbook and known tradeoffs up-to-date.

## 6. Optional extensions — after v1; separate opt-in work

| Extension | Approach / acceptance target |
| --- | --- |
| Caching | Redis + Nest CacheManager; cache-aside, TTL, explicit invalidation; core runs without Redis. |
| Jobs | BullMQ/Redis, retries/backoff, idempotent sample job, separate worker lifecycle. |
| Email | Provider adapter, template renderer and safe dev capture; no real credentials by default. |
| Storage | S3-compatible provider, presigned URLs, MIME/size constraints. |
| Domain events | Local `@nestjs/event-emitter` demonstration; use a transactional outbox for durable cross-process delivery. |
| Scheduling | `@nestjs/schedule` with multi-instance coordination rules. |
| Messaging | Documentation-only recipe for broker abstraction, DLQ, idempotency and outbox; not compiled into core. |

Do not add empty abstractions to core merely to accommodate these extensions. Each opt-in extension gets its own README, installation instructions, environment schema fragment and tests when implemented.

## 7. Official documentation reviewed

- NestJS authentication: https://docs.nestjs.com/security/authentication
- NestJS authorization: https://docs.nestjs.com/security/authorization
- NestJS Drizzle: https://docs.nestjs.com/data/drizzle
- NestJS validation: https://docs.nestjs.com/application/validation
- NestJS configuration: https://docs.nestjs.com/techniques/configuration
- NestJS Swagger: https://docs.nestjs.com/openapi/introduction
- NestJS security headers: https://docs.nestjs.com/techniques/security
- NestJS CSRF: https://docs.nestjs.com/security/csrf
- NestJS health: https://docs.nestjs.com/reliability/terminus
- Node.js releases: https://nodejs.org/en/about/previous-releases

Documentation must be checked against pinned dependency versions at the time of each PR.
