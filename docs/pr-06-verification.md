# PR-06 verification

Verified locally on **2026-10-12**, using Node **24.21.0**, pnpm **10.33.0** and macOS arm64. Branch `feat/pr-06-authentication` starts from the latest fetched `origin/main` commit **84bf5f2**, after PR-05 was merged. Authentication remains pinned to the PR-00-verified **0.1.1** package. Its public declarations, implementation behavior, official documentation and both ADRs were inspected before implementation.

## Changes

- `src/modules/auth/`: official authentication module/options, JWT bearer provider, browser Origin guard, strict schemas, register/login/refresh/logout controller/service and PostgreSQL RefreshTokenStore. No custom JWT/password framework or auth administration endpoints.
- `src/database/schema/auth.ts`, schema exports and `migrations/0002_authentication.sql` plus metadata: family/session identity, hashed refresh tokens, composite owner FK and durable revocation tombstones. Existing migrations and data are preserved.
- `src/modules/users/users.repository.ts`, `users.module.ts`: a dedicated internal ID/password-hash projection available to AuthService; ordinary UsersService behavior and public projections remain unchanged.
- `src/config/environment.ts`, `src/configure-application.ts`, application module/controller: required signing/origin settings, native CSRF/security headers, credentialed CORS, global bearer guard and explicit public starter routes. The migration CLI uses database configuration without auth secrets.
- `.env.example`, `compose.yaml`, `scripts/verify-compose.sh`: required API auth settings, generated disposable smoke-test secrets, and container registration/login/rotation/logout checks after explicit migration.
- Tests: real PostgreSQL contract/race/HTTP/upgrade coverage, isolated environment/startup checks, and a disposable manual browser fixture. Existing test config overrides and Swagger path expectations include the new feature.
- README and database/users/Docker/authentication guides: configuration, browser topology, lifecycle, retention, limitations and reproducible checks.
- Only new direct dependency: development-only `@types/express@5.0.6`, verified in PR-00, plus its type dependencies. No new runtime package or optional infrastructure.

## Executed local checks

| Command / check                                                                      | Result                                                                                                           |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                     | Exit 0; existing store selected with `npm_config_store_dir`                                                      |
| `pnpm lint`                                                                          | Exit 0                                                                                                           |
| `pnpm format:check`                                                                  | Exit 0                                                                                                           |
| `pnpm typecheck`                                                                     | Exit 0                                                                                                           |
| `pnpm test`                                                                          | Exit 0; **90 passed**, 5 suites, none skipped                                                                    |
| `pnpm test:integration`                                                              | Exit 0; **61 passed**, 5 suites, none skipped; actual PostgreSQL 17 via Testcontainers                           |
| `pnpm build`                                                                         | Exit 0; production ESM output                                                                                    |
| `DATABASE_URL=postgresql://localhost/example pnpm db:generate --name=authentication` | Exit 0; committed additive SQL and metadata generated offline                                                    |
| `bash -n scripts/verify-compose.sh`                                                  | Exit 0                                                                                                           |
| `bash scripts/verify-compose.sh`                                                     | Exit 0; production/migration image builds and Compose HTTP/auth/migration/persistence/shutdown verification      |
| Manual browser fixture                                                               | **10 checks passed** in the Codex in-app browser on localhost; fixture shut down and disposable database removed |
| `git diff --check`                                                                   | Exit 0                                                                                                           |

The 61 integration cases comprise **16 store cases** (including all **5 official contract cases**), **24 auth HTTP cases**, 9 existing database cases, 10 users cases and 2 migration upgrade cases. Contracts were selected with `contracts: ['refreshTokens'], concurrent: true` and executed, not merely imported. All normal persistence and authentication behavior uses a real pooled PostgreSQL store. Test-only ID mapping provisions UUID users for the harness's `user-<uuid>` fixtures; it does not replace storage. A separate outage case uses explicit fault injection to check safe 503/cookie behavior.

Executed security/concurrency proofs include eight-way atomic consumes, competing TokenService refreshes, mixed-family owner isolation, immutable app claims/session identity, revocation before initial insert and after successor insert, incomplete family transaction rollback, interrupted-successor state, both lock orders for logout-all versus first issuance and rotation, and account deletion. Races are coordinated through observed PostgreSQL lock waits rather than arbitrary sleeps. HTTP tests cover JWT signatures/expiration/current-user lookup, correct/incorrect/absent passwords, replay/rotation, absolute expiry, no plaintext refresh storage, safe response/log fields, CSRF/Origin restrictions, CORS preflight, cookie expiry/clearing and revocation across a new app/pool.

Migration tests apply actual earlier migrations, insert existing example/user/credential data, then apply the full chain twice and verify preservation. All migrations remain explicit; startup does not apply schema changes.

The Compose run builds both targets, verifies non-root runtime contents and unchanged public endpoints, applies **three** migrations explicitly, and exercises register/login/refresh/logout using production scrypt defaults. PostgreSQL data survives restart and forced container recreation. Shutdown exits are API **143** (SIGTERM) and PostgreSQL **0**, without an API OOM kill. The unique test project/network/volume is removed. Initial verification used Docker Engine 29.8.0; final integration/Compose verification used the restored Engine 29.8.2.

The real browser check ran `node .test-dist/test/manual/auth-browser.js` against its own migrated Testcontainers database. The browser automatically managed cookies on credentialed requests: registration, access-only JSON, HttpOnly invisibility, in-memory bearer use, Secure-cookie sending, no-store, cookie replacement on rotation, logout, cookie removal and password login all passed. This proves the tested localhost browser flow, not a production TLS deployment, other browser engines or cross-site/third-party-cookie compatibility. Cookie flags/Origin rejection are also asserted in automated HTTP tests. The manual fixture is not part of CI or the production build.

## GitHub CI

The existing **CI / Verify** workflow executes frozen install, lint, formatting, typecheck, application tests, real Testcontainers integration tests, build and Compose verification on Ubuntu. Local results do not establish hosted success. The PR description and final delivery report record the actual GitHub conclusion and link the run for the delivered commit after it completes. No CI permissions, branch protection or merge settings were changed.

## Findings and remaining limits

Final review covered credential exposure, origin/cookie behavior, revocation races, migration safety, dependencies and milestone scope. No known blocking implementation issue remains. Secrets are generated/injected, never committed. Compatibility spike, previous SQL and ADR documents remain intact.

Two installed-API details were resolved during testing: the package's token digest encoding is base64url, and Drizzle insert-select requires explicit matching fields including the revocation timestamp. One contract qualification is documented in the auth guide: generic sid-less records can omit optional claims; application families carrying `sid` reject all claim changes/omission. This preserves the official round-trip contract while enforcing application family identity.

Intentional operational/security limits remain: access JWTs may live up to 15 minutes after refresh revocation; browsers must serialize refresh attempts; same-site HTTPS is the supported deployment topology; rate limiting/general hardening remain PR-10; auth table retention needs a reviewed maintenance process; registration conflicts can reveal email availability; user creation and token issuance are separate operations, so a token-storage failure can leave an account that must retry via login. These are documented in `docs/authentication.md`. No session administration, RBAC, user CRUD API, OAuth, MFA, password reset or optional extension was added.

Earlier integration attempts failed because Docker Desktop was stopped; those were environment failures, not reported as passing tests. Docker was started and the full suite executed successfully afterwards. A usage-limit failure in automatic approval review also prevented one command from executing; work resumed after the user requested continuation. Existing non-blocking Jest VM-module and pnpm ignored-install-script notices remain. The next milestone is PR-07 session administration.
