# Users API and account lifecycle

PR-09 adds account endpoints in `UsersModule`, using the existing PostgreSQL schema, package-backed scrypt, bearer authentication and explicit `UsersPolicy` abilities. Authentication endpoints remain in `AuthModule`. No migration, dependency or environment setting is added.

PR-10 adds rate limiting in front of these endpoints (see [security](security.md)): password changes and administrator update/delete have an additional limit of 3 requests per 60 s per IP per handler, shared by users behind that IP. User reads, profile updates and self-deletion use only the global 100/60 s per-IP, per-handler limit. These guards run before authentication and do not claim per-user isolation. JSON bodies are capped at 16 KiB by default (413 beyond that).

## HTTP contracts

All paths below start with `/api/v1`. Every route requires a verified bearer JWT; every mutation additionally requires an exact trusted `Origin` and retains native CSRF protection. Credentialed CORS permits PATCH and DELETE. All users responses, including rejected requests, use `Cache-Control: no-store`.

| Endpoint                   | Permission          | Strict input                            | Success                     |
| -------------------------- | ------------------- | --------------------------------------- | --------------------------- |
| `GET /users/me`            | `readSelf`          | None                                    | 200 public user             |
| `PATCH /users/me`          | `updateSelf`        | `{ email?, displayName? }`              | 200 public user             |
| `PATCH /users/me/password` | `changeOwnPassword` | `{ currentPassword, newPassword }`      | 204                         |
| `DELETE /users/me`         | `deleteSelf`        | Empty body or `{}`                      | 204                         |
| `GET /users`               | `manage` (admin)    | Query described below                   | 200 `{ items, nextCursor }` |
| `GET /users/:id`           | `manage` (admin)    | UUID path parameter                     | 200 public user             |
| `PATCH /users/:id`         | `manage` (admin)    | UUID; `{ email?, displayName?, role? }` | 200 public user             |
| `DELETE /users/:id`        | `manage` (admin)    | UUID; empty body or `{}`                | 204                         |

The public projection contains **only** `id`, `email`, `displayName`, `role`, `createdAt` and `updatedAt`. HTTP dates are ISO UTC strings; internal service dates are `Date` objects. Queries and `RETURNING` use explicit allowlists, never entire database rows. Password hashes and authentication storage fields are never part of the response. Swagger `/docs-json` describes the same explicit Zod request/response schemas.

Self-service identity comes exclusively from `@CurrentUser()`, never a body, query, cookie or target ID. All bodies are strict. Both profile update schemas require at least one supported field. Email is trimmed, lowercased, limited to 254 characters and validated with Zod; no provider-specific rewriting occurs. Display names are trimmed, 1–100 characters, or `null` to clear. `id`, hashes, passwords, timestamps and unknown fields are rejected. Only the **separate administrator schema** permits `role: 'user' | 'admin'`; the service and repository preserve this separation.

Responses: 400 for invalid input or incorrect current password; 401 for absent/invalid credentials or a deleted principal; 403 for forbidden operations or untrusted Origin; 404 for a missing target (including a self account deleted after authentication); 409 for duplicate email, a concurrent password replacement or prohibited administrative self-target; 503 for sanitized persistence failures. Successful deletion and password change have no body. Database constraint names, SQL, parameters and original error causes are not exposed. Email conflict responses reveal availability, consistent with registration.

### Administration and lockout boundaries

Every administrative handler declares `@Can(UsersPolicy, 'manage')`. Ordinary users receive 403 even when targeting themselves. Roles are loaded from PostgreSQL on **each authenticated request**; JWT role claims have no authority. A role change affects the next request, including existing JWTs and refresh families, without token reissuance. It does not revoke sessions. Requests already authorized in flight may finish using that request's role snapshot.

Administrative self-deletion and self-demotion return 409, including uppercase UUID targets. Deliberate self-deletion remains available via `/users/me`, including for an administrator. This is not a global last-admin guarantee: an administrator can intentionally delete their own account, and concurrently authorized administrators can demote/delete one another. Provision the initial admin and recover administrator access through controlled database operations; there is no public admin registration, reset endpoint or new permission infrastructure.

### Search, ordering and pagination

`GET /users?limit=20&sort=createdAt&order=desc&search=alice&after=<nextCursor>`:

- `limit`: integer 1–100, default 20.
- `search`: optional trimmed 1–100-character **literal**, case-insensitive substring of email or display name. `%`, `_`, quotes and SQL-looking text have no wildcard/expression semantics.
- `sort`: only `createdAt` (default) or `email`.
- `order`: only `asc` or `desc` (default). The UUID tie-breaker uses the same direction.
- `after`: optional UUID of the last item from the previous page. `nextCursor: null` means no further page.

Keep search/sort/order unchanged while following a cursor. The query uses a stored anchor and a `(sort-column, id)` keyset comparison, preserving database timestamp precision. A new record ahead of the cursor does not shift later pages. A missing/deleted anchor produces an empty page; restart pagination. This is a live view, not a cross-request snapshot: email edits can move rows in email ordering, search membership can change, and deletions can remove rows. Use `createdAt` ordering to avoid profile-update movement. Sort identifiers and operators are chosen from fixed code; all search and cursor values are parameterized. There is no arbitrary SQL, offset pagination or count query. Substring search can scan rows; advanced search/indexing is outside this milestone.

## Password change and concurrency

The strict request requires the current password (1–128 code units) and a valid new password. `PasswordsService` verifies the stored hash and uses official `PasswordHasher` for the new scrypt hash. A wrong current password returns generic 400 `Unable to change password`. No password/hash is logged or returned. The same new password is permitted; verification still occurs and other families are still revoked.

Expensive verification/hashing occurs **outside** the transaction. The repository then locks the user's row with `SELECT … FOR UPDATE` and compares its current hash with the hash just verified. A mismatch returns 409 without a write; two requests verified against the same hash cannot silently overwrite each other. A later request that reads the new hash but supplies the old password instead returns 400. This uses the existing hash as a compare-and-set version; no schema version column is necessary.

Within that same transaction, it updates the hash/timestamp and inserts persistent revocation tombstones for every other family. Revocation failure rolls back the password update. Family saving, logout-all, password change and deletion all use the established **user-row-first** lock order.

Only the server-generated `sid` from verified `@CurrentSession()` can identify a family to preserve. Under the user lock, it must match the authenticated owner, persisted family UUID and stored `sid` claim; the family must be unrevoked/unexpired with a live unspent token. Missing/invalid/unmapped/foreign/revoked/expired identity preserves **no** family. A concurrent replay/revoke can still revoke the preserved family; the workflow never removes tombstones. Rotations preserve their family identity and remain subject to strict one-time consumption/replay revocation.

The password endpoint **never sets or clears the refresh cookie**. Bearer A may coexist with cookie B after another tab logs in. The bearer controls which family can be preserved; the cookie neither authorizes that choice nor substitutes for missing `sid`. An owned cookie B becomes unusable when B is revoked and is cleared by the next failed refresh; a foreign-account cookie stays valid and untouched. Coordinate browser authentication operations across tabs.

Login also carries the just-verified hash through a narrowly scoped `AsyncLocalStorage` context into the application's `PostgresRefreshTokenStore`. The store compares it under its existing user lock **before** saving the initial family. The public package store API has no transaction/credential-version argument; this application-local precondition avoids private package APIs, new token claims or a schema change. A login saved first is included in password-change revocation; a login verified against the old hash but saved after the change fails with 401. Registration uses this same verified-login path after inserting the account. Newly verified logins with the new password are allowed. Direct internal `TokenService.issue` calls without this wrapper are trusted server operations; do not use them for password login adapters.

**Already-issued access JWTs may remain valid until expiry (up to 15 minutes), including JWTs returned concurrently with password change/revocation.** Bearer verification checks current account existence and role, not family tombstones. Password change does not revoke access JWTs immediately.

## Account deletion and retention

Self and administrator deletion call the same repository transaction:

1. Lock the target user row (`FOR UPDATE`); return 404 if it no longer exists.
2. Insert tombstones for **all** owned families with `ON CONFLICT DO NOTHING`, preserving existing revocation evidence.
3. Hard-delete the user. Existing FKs cascade from user → families → hashed refresh-token rows.
4. Commit before reporting 204 or clearing any cookie.

Self-deletion clears `__Host-refresh` using the existing HttpOnly/Secure/SameSite=Lax/Path=/ options with no Domain. This deliberately clears the request browser's cookie even if another tab has switched accounts; delete from the intended browser account. Administrator deletion does not change the administrator's browser cookie. A failed transaction returns 503 and does not clear a retryable cookie or claim success.

`auth_revoked_families` has no family FK by design. Deletion retains existing and newly inserted tombstones, including unknown-family markers. It removes profile data, hashes, family metadata and token rows, but retains family-ID/revocation-time evidence. Once cascades remove the family deadline, there is no safe automatic expiry bound: **account-deletion tombstones are retained indefinitely** until an operator adopts an explicit safe retention strategy. Do not age them out solely by `revoked_at`. No cleanup scheduler is added; see [ADR-002](adr/002-auth-session-model.md) and [auth retention](authentication.md#retention-and-operational-limits).

A refresh/login saved before deletion is cascaded and tombstoned; one waiting behind deletion fails the store's locked account-existence check. A pending successor cannot recreate the user. Refresh also checks existence before rotation and at the response boundary. The next bearer request rejects the deleted subject with 401, even across app/pool restart. An already-running authorized request may finish, and an overlapping issuer may have returned a JWT, but subsequent verification rejects it. Re-registering the same email creates a new UUID and cannot restore the deleted identity.

## Persistence and password costs

The internal `UsersService` still supports strict ordinary-user `create`, `findById`, `findByEmail` and `update`. Feature workflows map safe repository errors to HTTP outcomes. `UsersRepository.findAuthenticationCredentials()` and `findPasswordHash()` are internal credential projections; never expose or log them. Normal update writes explicitly omit role even if an unsafe caller supplies extra properties.

PostgreSQL's unique index on `lower(email)` is authoritative, including mixed-case direct SQL and concurrent requests. There is no racy pre-check. Repository writes maintain `updatedAt` with `statement_timestamp()` and preserve `createdAt`; direct SQL callers must maintain timestamps too. Apply existing migrations explicitly with `pnpm db:migrate`; startup does not push schemas.

New passwords have 12–128 JavaScript code units, are not trimmed, and fit 4096 bytes after NFKC normalization. The pinned `@nestjs/authentication@0.1.1` owns normalization, salts, hash encoding and verification. Production scrypt defaults remain `logN=17`, `r=8`, `p=1`, 16-byte salt, 32-byte derived key: approximately 128 MiB per concurrent derivation. Registration performs hash then verification sequentially (kept deliberately so the verified-login credential-version check protects first token issue; see [security](security.md#password-hashing-resources)); login/password changes also require derivation capacity. Budget memory/threadpool usage; PR-10 rate limiting runs before these derivations. Tests use reduced cost only through test-provider overrides, plus a real production-cost password utility test.

## Verification

Run `pnpm test` and `pnpm test:integration` sequentially (both rebuild `.test-dist/`), then `bash scripts/verify-compose.sh`. HTTP integration tests use the established native-fetch ephemeral Nest server fixture and real migrated PostgreSQL, with pooled connections and observed database lock waits rather than timing delays. Fault-injection triggers exercise transaction rollback. Existing official refresh-store concurrency contracts remain enabled.

See [PR-09 verification](pr-09-verification.md) for exact results. Package evidence: installed public `PasswordHasher`, `@CurrentSession`, `JwtBearerProvider`, `TokenService` and `RefreshTokenStore` declarations/source; [official authentication documentation](https://docs.nestjs.com/security/authentication). No password reset, email verification, MFA or general security-hardening milestone is included.
