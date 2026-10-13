# PR-08 verification — Authorization, RBAC and ownership

Verified locally on 2026-10-13 using Node **24.21.0**, pnpm **10.33.0**, Docker engine **29.8.2** and real PostgreSQL **17** Testcontainers databases. Branch `codex/pr-08-authorization` starts from latest `origin/main` **8f4e554**, which includes PR-07 and its cookie association correction.

## Implementation and package verification

Added only the PR-00-verified `@nestjs/authorization@0.1.0`. Its public exports, `Policy`/`Can` declarations, typed abilities and argument rules, module/global guard registration, default HTTP user lookup and runtime guard behavior were inspected in the installed package and checked against the [official authorization guide](https://docs.nestjs.com/security/authorization). Peers resolve against the existing Nest 12.1.3 and authentication 0.1.1 packages. The lockfile adds only this package; no framework replacement or optional infrastructure was introduced.

`AppModule` imports `AuthModule` before `AppAuthorizationModule`, so authentication's singleton global guard runs first. The official authorization module keeps its global deny-by-default behavior and default authenticated-user resolver. Registered `@Policy()` providers expose explicit `SessionsPolicy.listOwn/revokeOwn/logoutAll` and `UsersPolicy.readSelf/manage` abilities. Guests and unknown roles are denied. Only `UsersPolicy.manage` permits administrators exclusively; no administrator bypass applies to other policies or undeclared routes.

The three production session endpoints declare their abilities and Swagger 401/403 outcomes. The six intentionally public starter/authentication handlers keep `@Public()`. User roles come from the existing database-backed bearer provider, not JWT role claims or request data. Existing session SQL, atomic tombstone insertion, cookie-owner/family association and logout-all locking are unchanged. No users/admin production endpoints, migrations, schema changes, throttling or later-milestone features were added.

## Executed local checks

| Command                          | Result                                                                |
| -------------------------------- | --------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Exit 0, lockfile current                                              |
| `pnpm lint`                      | Exit 0, no warnings                                                   |
| `pnpm format:check`              | Exit 0                                                                |
| `pnpm typecheck`                 | Exit 0                                                                |
| `pnpm test`                      | Exit 0, **94 passed, 0 failed, 0 skipped**, 6 suites; 7.611 seconds   |
| `pnpm test:integration`          | Exit 0, **108 passed, 0 failed, 0 skipped**, 7 suites; 27.263 seconds |
| `pnpm build`                     | Exit 0, production ESM output                                         |
| `bash scripts/verify-compose.sh` | Exit 0, production image and Compose lifecycle verified               |
| `git diff --check`               | Exit 0                                                                |

Unit and integration commands ran sequentially because both rebuild `.test-dist/`. An initial new test incorrectly expected an `error` field in the package's native 403 response; the actual response is `{ message: 'Forbidden', statusCode: 403 }`. The assertion was corrected without changing exception handling, and the full integration suite passed. Existing pnpm warnings about deprecated transitive packages/ignored dependency build scripts and Jest's experimental VM Modules warning remain; no script-approval settings were changed.

Docker Compose passed the non-root production runtime, explicit migrations on empty/existing data, public and protected auth/session HTTP flows, database persistence through restart/recreation, and clean shutdown (API 143, PostgreSQL 0, no API OOM). The isolated smoke project and volume were removed. The script was unchanged and ran with the new global guard enabled. Hosted CI is a separate gate; its final commit/run/conclusion is recorded in the PR description and Checks tab after GitHub completes. Local test success is not a claim about GitHub CI.

## Test coverage

Four focused policy unit cases exercise every ability for a guest, ordinary user, administrator and unexpected future/invalid role. The ordinary application suite also asserts bearer and 401/403 Swagger declarations, unchanged public paths and absence of production test-fixture endpoints.

Nine new HTTP integration cases use real migrations, users, package password authentication, signed JWTs, current-user DB lookups and official guards/policies:

- Missing/invalid credentials return 401 before authorization emits a denial; an ordinary user's admin request produces 403 and a safe native response. Authorized self access returns 200.
- Promotion and demotion affect the next request with the same JWT.
- Even correctly signed stale `role` claims and client privilege hints cannot override the database role.
- Undeclared routes return 401 anonymously and 403 for both user and admin.
- Wrong signatures, expired JWTs and deleted accounts fail authentication before policy evaluation.
- Both supported roles list only their sessions, cannot revoke another user's session or delete its cookie, can revoke their own and can logout all their own devices.
- Public starter, register, login, refresh and logout flows continue working.

The admin and undeclared controllers are fixtures passed only to the test app; they are absent from `src/` and the production build. Tests subscribe to the package's public authorization events and retain only decision metadata, without logging users or arguments. No authentication/storage mocks replace normal integration operations.

The existing **99 PostgreSQL tests** remain enabled: 38 session tests (including the cookie A/B regressions), 24 auth HTTP tests, 16 refresh-store tests (all five official concurrent contract cases), 9 database tests, 10 users tests and 2 migration upgrade tests. Thus existing strict input validation, ownership, native CSRF, Origin/CORS, secure-cookie scope, replay, restart, concurrent revocation and migration guarantees are exercised with the new guard active.

## Changed files

- `package.json`, `pnpm-lock.yaml`: exact authorization dependency.
- `src/app.module.ts`: authentication-before-authorization composition order.
- `src/modules/authorization/authorization.module.ts`, `policies/sessions.policy.ts`, `policies/users.policy.ts`: official module registration and focused typed policies.
- `src/modules/auth/sessions.controller.ts`: explicit abilities and Swagger denial responses.
- `test/policies.spec.ts`, `test/integration/authorization.spec.ts`: policy matrix and real HTTP/DB regressions.
- `test/helpers/auth-app.ts`: explicit self policy and optional test-only controllers.
- `test/app.spec.ts`: Swagger denial assertions.
- `README.md`, `docs/authorization.md`, `docs/authentication.md`, this report: conventions, guard order, ownership and executed evidence.

Final manual review checked every production route's declaration, no authentication bypass or global admin override, current database role use, safe error bodies, unchanged atomic owner predicates and cookie cleanup, dependency diff and exclusion of fixture endpoints. No secrets, schema changes or unrelated production behavior were introduced.

## Limits and next milestone

No known implementation issue remained after the passing local checks. Authorization uses the user loaded for a request; a role change during that same request is not a retroactive cancellation. Refresh revocation still permits already-issued access JWTs until their 15-minute expiry, while role changes and account deletion are reflected on subsequent bearer lookups. Existing browser cookie/retention limits remain documented in the authentication guide.

No interactive browser fixture was rerun for this server-side authorization change; HTTP security and production container checks provide the executed evidence. This is the PR-08 baseline; PR-09 Users APIs and PR-10 general hardening remain out of scope.
