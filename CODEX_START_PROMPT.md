# Codex kickoff prompt — PR-00

We are building a production-ready NestJS REST starter. Read `AGENTS.md` and `NESTJS_STARTER_IMPLEMENTATION_PLAN.md` before doing anything.

**Task:** Execute **PR-00 only — compatibility spike and architecture records**. Do not start PR-01 or scaffold the whole application yet.

1. Inspect repository contents; identify existing dependencies, constraints and any prior code.
2. Validate current versions and API compatibility for NestJS 12.1+, `@nestjs/drizzle`, Drizzle, Zod 4.2+, `@nestjs/config`, `StandardSchemaValidationPipe`, `@nestjs/swagger`, `@nestjs/authentication`, `@nestjs/authorization`, native security headers and CSRF.
3. Verify the intended JWT access + rotating refresh-token flow with PostgreSQL storage. Determine how to handle refresh tokens in secure browser cookies without undocumented package hooks.
4. Determine how `/auth/sessions` can list/revoke token-based device sessions or refresh-token families, distinct from cookie-based `SessionService` sessions. Do not promise an unsupported package feature.
5. Check module-global guard registration order and authentication store requirements for production startup; identify where atomic updates and concurrency contract tests are required.
6. Record decisions as `docs/adr/001-auth-transport.md` and `docs/adr/002-auth-session-model.md`; add a short compatibility report with tested versions, exact commands, results and unresolved issues.

**Rules:** Prefer official docs and installed TypeScript definitions. Do not fabricate APIs, claim tests passed without running them, commit secrets, or implement later PR tasks. When the spike ends, provide a concise report and proposed adjustments to the plan if necessary.

**Acceptance:** Reproducible evidence that the planned core dependencies fit together, plus ADRs that remove ambiguity around browser refresh cookies and bearer session management.
