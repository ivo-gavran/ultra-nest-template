# PR-07 verification — Authentication session administration

Verified locally on 2026-10-12, from `origin/main` commit `4782e1c` on branch `codex/pr-07-session-administration`. Runtime: Node **24.21.0**, pnpm **10.33.0**, Docker Desktop engine **29.8.2**, real PostgreSQL **17** Testcontainers databases. Existing pinned packages, ESM setup, schema, migrations, ADRs and compatibility spike are preserved.

## Implemented behavior

- Bearer-protected `GET /api/v1/auth/sessions` returns an owner-scoped public projection with deterministic timestamp/UUID keyset pagination, active/expired/revoked status and current identity from verified `@CurrentSession()` JWT `sid`.
- `DELETE /api/v1/auth/sessions/:id` inserts an owner-filtered tombstone atomically. Unknown/foreign/repeated IDs return 204. Existing and subsequently written refresh successors remain revoked. Cookie cleanup follows the presented cookie’s persisted owner/family association (see the 2026-10-13 correction below). Only newly inserted tombstones emit the credential-free `auth.session.revoked` audit event.
- `POST /api/v1/auth/logout-all` invokes public `TokenService.revokeAll` with the verified current user's ID, preserving the existing user-row locking protocol. New logins ordered after logout-all are allowed.
- Shared secure cookie scope, trusted-Origin checks, native CSRF, credentialed DELETE CORS, strict Zod inputs and auth no-store middleware cover successful and rejected requests. Storage failures return generic 503 without clearing retryable cookies.
- No dependencies, migrations, second session store, authorization policies or later-milestone features were added.

## Executed checks

| Command                          | Exact final local result                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint`                      | Exit 0, no warnings                                                                                                                  |
| `pnpm format:check`              | Exit 0, all matched files formatted                                                                                                  |
| `pnpm typecheck`                 | Exit 0                                                                                                                               |
| `pnpm test`                      | Exit 0, **90 passed, 0 failed, 0 skipped**, 5 suites                                                                                 |
| `pnpm test:integration`          | Exit 0, **89 passed, 0 failed, 0 skipped**, 6 suites                                                                                 |
| `pnpm build`                     | Exit 0, production ESM build                                                                                                         |
| `bash scripts/verify-compose.sh` | Exit 0, production image/runtime, explicit migrations, HTTP/session smoke, persistent data, restart/recreation and shutdown verified |
| `git diff --check`               | Exit 0                                                                                                                               |

The ordinary and integration suites ran sequentially because both compile `.test-dist/`. The final integration run took 21.927 seconds; unit tests took 6.891 seconds. Jest emitted its existing experimental VM Modules warning. An initial integration run exposed an SQL alias error in cursor pagination; it was corrected and the full suites then passed. Initial lint rejected unnecessary non-null assertions in the Swagger test; they were removed before the passing lint/type/build checks.

Compose verified the non-root Node 24.21.0 runtime without source/dev tooling, disabled production docs, actual migrations on empty/existing data, registration/login/rotation/logout, session listing/current identity, targeted revocation and logout-all. PostgreSQL data survived restart and container recreation. Graceful exits were API **143** and PostgreSQL **0**, with no API OOM. The script removed only its unique disposable project and volume.

Hosted GitHub CI is a separate gate from these local results. The PR description and Checks tab record the final commit, run URL and conclusion after GitHub completes its install/lint/format/typecheck/unit/integration/build/Compose pipeline; this local report does not infer hosted success.

## Database and HTTP coverage

The **28 new session cases** use a fresh migrated PostgreSQL container and real authentication flows, not mocked repositories or auth services. They cover:

- Own-only listing, two-device current flags, sid preservation through rotation and another account's cookie failing to override bearer identity.
- Revoked precedence, expired family/token, spent-only/empty families and active state.
- Equal-timestamp UUID ordering, stable multi-page traversal during a newer login, repeat pages, foreign/unknown cursors and invalid/extra query fields.
- Owned, foreign, unknown, repeated, current/non-current and uppercase-UUID revocation; unchanged token records, exactly one safe audit event, restart persistence and successor rejection.
- Logout-all across devices, foreign-user isolation, secure cookie deletion, new login and access JWT expiry behavior.
- Missing/malformed/forged bearer credentials, deleted accounts, UUID/body validation, untrusted/missing/null/lookalike Origins, native CSRF and trusted DELETE preflight.
- No family IDs, hashes, credentials or user PII in public projections/audit logs; missing signed sid results in no invented current identity.
- A real storage outage (temporarily renamed revocation table, restored in `finally`) returns 503 without claiming success or losing the cookie.
- PostgreSQL-observed lock waits coordinate both ordering cases for HTTP logout-all versus login and refresh, without arbitrary sleeps. A separate barrier test revokes a family while its successor write is queued, then proves the persisted successor remains unusable.

Existing coverage stays intact: **24** auth HTTP tests, **16** refresh-store tests (including all **5** official concurrent store-contract cases), **9** database tests, **10** users tests and **2** real migration upgrade tests. OpenAPI checks verify bearer requirements, UUID parameters, pagination bounds/default and the strict public response schema. Existing auth HTTP tests now expect unauthenticated logout-all to return 401 instead of the former 404.

## Changed files and review

- `src/modules/auth/sessions.controller.ts`, `sessions.service.ts`, `sessions.repository.ts`, `schemas/session.schema.ts`: transport, workflows, owner-filtered SQL and Zod contracts.
- `src/modules/auth/refresh-cookie.ts`, `auth.controller.ts`, `auth.module.ts`: shared cookie attributes and feature registration.
- `src/configure-application.ts`: auth no-store middleware before guards/CSRF and DELETE in CORS.
- `test/integration/sessions.spec.ts`, `test/integration/auth.spec.ts`, `test/app.spec.ts`: database/security/concurrency regressions and generated OpenAPI assertions.
- `scripts/verify-compose.sh`: production session smoke coverage.
- `README.md`, `docs/authentication.md`, `docs/database.md`, this report: operation, pagination, session semantics and evidence.

Final manual review checked owner predicates in both outer listing and cursor anchor, atomic owner-filtered revoke, persistent tombstones, unchanged user-row lock ordering, verified-context identity, no public administration routes, explicit safe response fields, cookie scope, error sanitization and scope boundaries. No credentials or production secrets were added. No changes to package manifests/lockfiles, auth storage implementation or migration history were required.

## Remaining limitations

- Access JWTs can remain valid for up to **15 minutes** after refresh-family revocation, including for these administration endpoints. Account deletion is checked immediately on the next authenticated request.
- Current means the verified bearer login; a browser cookie can differ after another tab signs in. Signed sid-less tokens have no current row.
- Pagination is a live keyset view; a maintenance-deleted anchor returns an empty page. Status uses the PostgreSQL clock and requires synchronized application/database clocks.
- Active indicates a usable stored token, not proof of browser delivery. Existing strict replay handling and interrupted-rotation behavior remain unchanged.
- Audit events intentionally omit identity attribution to avoid logging PII or sensitive claims. Retention/cleanup and table growth retain the documented PR-06 operational limits.
- New cookie behavior was verified through real HTTP, PostgreSQL and production containers. The interactive browser fixture from PR-06 was not rerun for PR-07; no new browser compatibility certification is claimed. Same-site HTTPS/Lax restrictions remain.
- No known implementation blocker remained after local verification. Hosted CI must be confirmed on the final PR commit before reporting completion. The next planned milestone is PR-08 authorization, outside this change.

## Cookie association correction — 2026-10-13

Review identified that matching the target UUID against the bearer `sid` could delete a different tab's refresh cookie, or leave the targeted cookie behind. Cleanup now hashes the presented cookie using the existing SHA-256/base64url format and queries the existing token/family tables. The token and family must both belong to the authenticated user, and the persisted family UUID must match the target. Bearer claims do not decide cookie cleanup. The separate atomic owner-filtered tombstone INSERT is unchanged.

Missing, invalid, unknown, overlong and foreign-user cookies are preserved. A matching persisted cookie is cleared with the unchanged Secure/HttpOnly/SameSite=Lax/Path=/ and no Domain attributes, including repeated revocation and spent tokens. The lookup only returns a boolean, sanitizes storage errors and neither consumes tokens nor exposes their hashes. No dependencies, migrations or authentication infrastructure were added.

Ten additional real PostgreSQL cases cover bearer A/cookie A/revoke A; bearer A/cookie B/revoke A and revoke B; missing/invalid/unknown/overlong/foreign cookies; a foreign cookie matching a foreign target; and cleanup of a spent token without deleting refresh records. Existing restart/idempotency checks now present the actual successor cookie; Compose's deletion check also sends a real cookie.

Verification for this correction:

- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`: exit 0.
- `pnpm test`: **90 passed**, 5 suites, 7.542 seconds.
- `pnpm test:integration`: **99 passed**, 6 suites, 22.896 seconds, including **38 session cases** and the existing official concurrency contracts.
- The first integration attempt could not find a container runtime because Docker Desktop was stopped. After starting Docker engine 29.8.2, the complete suite ran successfully against real PostgreSQL 17; nothing was skipped or mocked.
- `bash scripts/verify-compose.sh`: exit 0; production image/runtime, explicit migrations, auth/session endpoints, persistence and clean shutdown passed (API 143, PostgreSQL 0).
- `git diff --check`: exit 0. Hosted CI must be confirmed on the correction commit; its SHA/run/conclusion is recorded in PR #9 after GitHub completes.

Manual review confirms the cookie association query scopes both persisted owners, resolves the target through its persisted family, and does not change atomic revocation or secure cookie attributes. The server can only match the cookie presented with the request; browser-side coordination is still needed if another tab changes cookies while a response is in flight.
