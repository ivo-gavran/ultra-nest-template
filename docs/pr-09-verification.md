# PR-09 verification — Users API and account lifecycle

## Scope and baseline

- Feature branch: `feat/pr-09-users-lifecycle`, created from fetched `origin/main` at `e10e497` (merged PR-08).
- Reviewed AGENTS, implementation plan, authorization/authentication guides, ADR-001/002, users/auth/session modules, migrations and existing PostgreSQL tests before implementation.
- Added all eight requested bearer-protected users endpoints with explicit policies, strict schemas and public projections. Authentication handlers remain in AuthModule; account handlers are in UsersModule.
- No migration, dependency, lockfile, environment setting, optional extension, generic permission engine or later-milestone infrastructure change.

## Executed local checks

Executed on 2026-10-13 with Node **24.21.0**, pnpm **10.33.0**, Docker Desktop and real Testcontainers PostgreSQL 17. Test helpers execute the version-controlled migrations and use pooled connections. Unit and integration commands ran sequentially because both rebuild `.test-dist/`.

| Command                          | Result                                                                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Passed with `CI=true` for noninteractive module-directory recreation; frozen lockfile unchanged                                                                  |
| `pnpm lint`                      | Passed, zero errors/warnings                                                                                                                                     |
| `pnpm format:check`              | Passed, all matched files formatted                                                                                                                              |
| `pnpm typecheck`                 | Passed                                                                                                                                                           |
| `pnpm test`                      | Passed: **7 suites, 99 tests**                                                                                                                                   |
| `pnpm test:integration`          | Passed: **8 suites, 137 tests**, including every official refresh-store contract with `concurrent: true`                                                         |
| `pnpm build`                     | Passed                                                                                                                                                           |
| `bash scripts/verify-compose.sh` | Passed: production image, auth/session/account flows, explicit/repeated migrations, persistence, runtime isolation and shutdown; API exit 143, PostgreSQL exit 0 |
| `git diff --check`               | Passed                                                                                                                                                           |

Initial environment corrections: the inherited shell had Node 24.5.0, and frozen install correctly failed its engine check. Installed/selected pinned Node 24.21.0, retained pnpm 10.33.0 on PATH, and used `CI=true` after pnpm refused noninteractive module-directory recreation. Docker Desktop was stopped and was started before PostgreSQL/Compose checks. Initial lint findings (unused argument/import and test spy references) were corrected; the final commands above passed. Install emitted ignored optional build-script/download-speed warnings; Jest emitted its existing experimental VM-modules warning. No checks were skipped.

## Evidence by behavior

### Self-service and administration

- Read/update own profile using the verified principal; normalized email, trimmed/nullable names, case-insensitive email conflicts, safe projections.
- Strict schemas reject mass assignment, role escalation, ID/hash/timestamp fields, password-verification bypass, invalid UUIDs, malformed pagination, unsupported sort/order and extra fields.
- Guest 401 and ordinary-user 403 on every administrative operation, including self-targets. Admin list/search/get/update/delete succeed.
- Admin role changes take effect on the next request with the same JWT; signed role claims cannot override the database role. Case-normalized admin self-demotion/self-deletion is blocked.
- Keyset pagination exercises tied timestamps, both supported sort columns/directions, literal search, UUID tie-breaking and an intervening new user. Missing cursor behavior and response field allowlists are asserted.
- Swagger path, bearer-security and separate strict request-schema assertions remain part of the unit/HTTP suite.

### Passwords and revocation

- Real package scrypt validates the new password and rejects the old one. Incorrect current passwords make no writes/revocations and receive a safe error.
- Two requests verified against the same hash are queued on an observed PostgreSQL user-row lock: one succeeds, the other returns 409; no silent overwrite.
- Real PostgreSQL trigger failure during tombstone INSERT rolls back the preceding password UPDATE and preserves retryable cookies.
- Verified current family is preserved; other devices are revoked. Missing/invalid/unknown/foreign/revoked/expired bearer session identities revoke all owned families.
- Bearer/cookie mismatch tests prove cookies are untouched, including a valid foreign-account cookie. An owned other-device cookie is revoked independently of cookie transport.
- Current-family rotation queued behind password change succeeds; rotations of other families and stale-password logins queued behind it fail. Both password-change/login and password-change/refresh lock orders are tested.
- Replay after a preserved-family rotation still revokes the family and its successor. Existing access JWTs retain their documented expiry behavior.
- Passwords, hashes and tokens are excluded from captured application logs and public account responses.

### Deletion and persistence

- Self-deletion commits before 204/cookie clearing; families and tokens cascade, known/unknown tombstones remain, foreign accounts survive.
- Revocation-trigger failure prevents deletion. A separate trigger failing the final user DELETE rolls back newly inserted tombstones and keeps all account/auth state.
- Existing bearer and refresh tokens fail after deletion and after app/pool restart. Re-registering the same email uses a new UUID. Saving a previously read token for the deleted owner fails.
- Deletion races login, refresh and password replacement in **both** observed lock orders. No account, family or token rows survive or are recreated.
- Administrator deletion exercises the same cleanup and preserves the administrator cookie.

### Existing regressions and production runtime

- All existing authentication, session ownership, CSRF, cookie-association, authorization guard-order/default-deny, migration and persistence tests remain enabled and pass.
- All five official RefreshTokenStore contract cases (including concurrency) still use the real production store through the existing fixture-ID adapter.
- Native CSRF and exact-Origin mutation protection remain enabled; account responses use no-store even for failures. Credentialed PATCH/DELETE preflights pass.
- Production Docker smoke now also covers own-profile read/update, mass-assignment rejection, guest/admin denial, password replacement, other-device revocation/current refresh, deletion and rejection of old credentials. SQL checks verify hard deletion and retained orphan tombstones after PostgreSQL restart.
- Existing non-root runtime, absent dev/test tooling, disabled production Swagger, repeat migrations, persisted volume and graceful shutdown assertions remain.

## Review and known limitations

Reviewed the complete change for privilege escalation, password/hash leakage, unsafe SQL, user-lock ordering, lost updates, rollback, family resurrection, deletion cascades, cookie identity confusion and accidental dependencies/migrations. No unresolved implementation blocker was found in local verification.

- Refresh revocation does not immediately revoke already-issued access JWTs; they may work for up to 15 minutes. Deleted-account JWTs fail the next database-backed authentication lookup. Already-authorized in-flight requests may finish.
- Password mutations intentionally leave cookies untouched. Browser clients must coordinate tabs; an owned cookie for a revoked different family is cleared on its next failed refresh. Self-deletion deliberately clears the browser cookie even if another tab switched accounts.
- Deletion tombstones are retained indefinitely because cascades remove family deadlines. There is no automatic cleanup scheduler; operators need an explicit safe retention policy.
- Pages are live keyset views, not snapshots. Email edits can move rows under email sorting, and deleted anchors require restarting pagination. Substring search can scan users.
- Admin self-target protection is not a global last-admin invariant. Intentional self-deletion and concurrent administrative changes can remove administrative access; controlled operational recovery remains necessary.
- Future password-login adapters must use the store's verified-password precondition. Its narrowly scoped in-process context bridges the public package API's lack of a credential-version argument; authoritative checks/locking remain in PostgreSQL.
- Scrypt cost remains approximately 128 MiB per concurrent derivation. Registration now hashes and then verifies sequentially through the login path. Rate limiting/general hardening remain PR-10.

## GitHub Actions

The unchanged `CI / Verify` workflow runs all requested checks, including Testcontainers and the extended production Compose smoke. The final PR head's run URL, commit and conclusion are reported in the PR/completion report after publishing; local results above are not a substitute for a GitHub Actions result. The PR targets `main` and is not to be merged as part of this task.

Next milestone: **PR-10 — general security hardening and rate limiting**.
