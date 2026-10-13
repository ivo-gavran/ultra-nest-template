# Authentication

The application uses `@nestjs/authentication@0.1.1` through its public `AuthenticationModule`, `TokenService`, `JwtBearerProvider`, `AuthenticationStorage` and `RefreshTokenStore` APIs. The existing package-backed `PasswordsService` handles scrypt. There is no custom JWT implementation, session-cookie provider or in-memory production store.

## Configuration and startup

The API requires these values in every environment:

| Variable               | Requirement                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SIGNING_KEY`     | 32 cryptographically random bytes encoded as exactly 64 hexadecimal characters; decoded to bytes for HS256                                    |
| `AUTH_TRUSTED_ORIGINS` | Comma-separated exact origins such as `https://app.example.com,https://api.example.com`; no paths, trailing slashes, credentials or wildcards |

There is no default signing key. Keep each deployment's key separate and inject production values from its secret manager. Never commit `.env`, paste keys into logs or reuse fixture credentials. A key change invalidates existing access JWTs; refresh families remain in PostgreSQL and can issue access JWTs with the new key. Coordinate keys across all API replicas.

After copying `.env.example` to `.env`, this local command fills its empty signing-key field without printing the key:

```sh
node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { readFileSync, writeFileSync, chmodSync } from "node:fs"; const path = ".env"; const text = readFileSync(path, "utf8"); if (!/^AUTH_SIGNING_KEY=$/m.test(text)) throw new Error("Expected one empty AUTH_SIGNING_KEY field"); writeFileSync(path, text.replace(/^AUTH_SIGNING_KEY=$/m, "AUTH_SIGNING_KEY=" + randomBytes(32).toString("hex"))); chmodSync(path, 0o600);'
```

Then set the exact frontend/API origins for your deployment. Production requires HTTPS origins. Development/test also allow HTTP on loopback hosts only. Invalid/missing auth configuration prevents startup. Migration generation/execution uses the shared database environment schema without auth settings; a migration worker does not need the signing key. Compose passes auth settings to the API only.

Access JWTs have a **15-minute** lifetime and `typ=at+jwt`. Opaque refresh tokens have a **7-day TTL and 7-day absolute family lifetime**. These explicit defaults live in `auth.options.ts`; rotation never extends the family deadline. Password costs and normalization remain as documented in [users persistence](users.md).

## HTTP and browser contract

| Endpoint                     | Success | Input                                      |
| ---------------------------- | ------- | ------------------------------------------ |
| `POST /api/v1/auth/register` | 201     | Strict `{ email, password, displayName? }` |
| `POST /api/v1/auth/login`    | 200     | Strict `{ email, password }`               |
| `POST /api/v1/auth/refresh`  | 200     | Empty body or `{}`; refresh cookie only    |
| `POST /api/v1/auth/logout`   | 204     | Empty body or `{}`; refresh cookie only    |

Every cookie-mutating endpoint requires an explicit allowed `Origin`, including same-origin browser requests. The bearer-only session listing does not require an Origin. Missing, `null`, foreign or lookalike origins receive 403. Native Nest CSRF protection and security headers run before handlers; CORS uses the same exact allowlist with credentials enabled. An allowed preflight does not replace the mutation's Origin check. CORS allows GET/POST/PATCH/DELETE/OPTIONS. Users mutations require the same trusted-Origin protection.

Registration always creates a `user`. Login uses the dedicated internal credentials projection and performs package verification even when the account is absent. Wrong/unknown credentials produce the same generic 401. Strict schemas reject client-supplied roles, hashes, session IDs and tokens. Duplicate registration returns a generic 409; like other registration conflict responses, this can reveal email availability. If account-enumeration resistance is required, redesign the registration UX in a later account lifecycle milestone.

Register/login/refresh return only `{ accessToken, expiresIn }`. Keep the access token in browser memory, send it as `Authorization: Bearer …`, and discard it on logout. Do not persist credentials in localStorage. The response sets `Cache-Control: no-store`. Browser code must use `credentials: 'include'` for cross-origin auth calls.

The refresh token appears only in `Set-Cookie: __Host-refresh=…`, with **HttpOnly, Secure, SameSite=Lax, Path=/** and **no Domain**. `Expires` comes from the persisted token record, not the access token's `expiresIn`; rounding to cookie-date precision cannot extend its life. The cookie flags stay secure in development. Logout and invalid/expired/replayed refresh clear the same cookie scope with a past expiry. Unknown/malformed logout credentials still return 204; a storage failure returns generic 503 and does not claim successful revocation or delete a retryable cookie.

Supported topology: an HTTPS frontend and API on the same site (for example `app.example.com` and `api.example.com`), or a same-origin HTTPS reverse proxy. Include all legitimate initiating origins, including the API origin if its Swagger/browser UI will initiate auth requests. Truly cross-site embedding/frontends are not supported by this Lax-cookie adapter. No `SameSite=None` fallback or insecure-cookie switch is provided. Local browsers may treat `http://localhost` as a Secure-cookie exception; use local HTTPS if yours does not. The default Compose HTTP port is intended for a local proxy or non-browser smoke checks; it is not a production TLS terminator.

## Guards and credential separation

The package's global authentication guard stays enabled. Only the four auth mutations and the original starter routes are marked `@Public()`. A test-only protected controller verifies bearer behavior without adding an extra production endpoint. New application routes are protected by default. `BearerProvider` validates signed claims and loads the current user from PostgreSQL on every authenticated request, rejecting deleted accounts and avoiding immutable role claims. The official authorization guard now runs after authentication and denies routes without an explicit policy or public declaration. Session listing, revoke and logout-all declare separate own-session permissions; both supported roles remain subject to the same SQL ownership predicates. See [authorization conventions](authorization.md).

`UsersRepository.findAuthenticationCredentials()` selects only ID/password hash for internal password verification. Ordinary UsersService methods and repository projections retain their public shape. Do not return or log the internal credentials object. Drizzle failures are sanitized at persistence boundaries; auth HTTP failures are mapped to generic messages without SQL parameters or original causes.

## Refresh storage and races

`0002_authentication.sql` is additive and preserves existing users, password hashes and example data. It creates:

- `auth_token_families`: internal family ID, unique public UUID `session_id`, user FK, creation/deadline timestamps and the immutable application claims.
- `auth_refresh_tokens`: SHA-256 **base64url** digest ID (the pinned package's format), family/owner composite FK, timestamps, nullable `used_at` and per-token claims. No raw token is stored.
- `auth_revoked_families`: durable family-ID tombstones and revocation timestamps. Deliberately no family FK: revocation can precede a pending first insert.

The store registers itself with `AuthenticationStorage` in its constructor before registry locking. It implements all six public methods. Reads include spent/expired records and convert optional database nulls back to `undefined`. `markRefreshTokenUsed` is one conditional `UPDATE … WHERE used_at IS NULL RETURNING`.

Creation generates a server-controlled `sid` and carries it through every rotation. The store creates a family and its first token in one transaction, preserves family identity on conflict and rejects owner/deadline/claim changes. Generic contract records without `sid` get a UUID mapping once. One pinned harness case writes full claims followed by omitted claims in the same generic family; the store preserves those per-record optional values. Explicit changed claims are rejected, and **all application families with `sid` must preserve their entire claims**, including when an attempted successor omits them. This is the narrow compatibility qualification to ADR-002's claims rule; the ADR's application identity/revocation semantics remain intact.

Both `saveRefreshToken` and `revokeUserRefreshTokens` lock the user's row with `SELECT … FOR UPDATE` before doing their work. This defines the logout-all ordering: a first login inserted before logout-all is revoked; a new family inserted afterwards can survive. An older family's successor remains revoked even when saved afterwards. Tombstones are never cleared by a save. Tests observe actual PostgreSQL lock waits to coordinate both orders on pooled connections, including `TokenService` rotations.

The package saves a successor before conditionally consuming its parent. Exactly one competing consume wins; losers revoke the whole family, including unreturned successors. At the HTTP response boundary the app rechecks family revocation/current-user existence, so an overlapping replay may result in zero or one successful response, never two. Browsers must serialize refresh requests across tabs where possible. A retry after a lost successful response can force a new login; there is no replay grace window.

Revocation persists across application/pool restarts. Deleting a user cascades families/tokens; tombstones remain. Refresh checks the account before rotation, and the store checks its existence under the user lock before writing. The response boundary also checks it again. Storage outages produce safe errors; they are not converted to successful refresh/logout.

Already-issued access JWTs can remain valid until expiry, including a token issued concurrently with logout/replay. Current-user lookup rejects deleted accounts, but the bearer provider does not consult family tombstones for each JWT. Immediate per-session JWT revocation is outside this milestone.

## Session administration

These endpoints require a valid bearer access JWT and use the same PostgreSQL refresh families. They do not use the package's separate cookie-session `SessionService` or introduce another store.

| Endpoint                           | Input                                                            | Success                     |
| ---------------------------------- | ---------------------------------------------------------------- | --------------------------- |
| `GET /api/v1/auth/sessions`        | Strict query: `limit` (1–100, default 20), optional `after` UUID | 200 `{ items, nextCursor }` |
| `DELETE /api/v1/auth/sessions/:id` | Strict UUID route parameter; trusted Origin                      | 204, empty body             |
| `POST /api/v1/auth/logout-all`     | Empty body or strict `{}`; trusted Origin                        | 204, empty body             |

Each item contains only `id` (public UUID), `createdAt`, `expiresAt` (absolute family deadline), `status` and `current`. Dates are ISO UTC strings. Never put access/refresh tokens into query strings or URLs. The list is ordered by creation time descending, then UUID descending. Pass `nextCursor` as `after` for the next page; null means the last page. The owner-scoped keyset uses stored timestamps without client-side rounding and a single query with a correlated existence check, avoiding N+1 queries. A newer login does not shift subsequent pages. Pages are live views, not a database snapshot; status can change between calls. A foreign, unknown or maintenance-deleted cursor returns an empty page; restart pagination after cleanup removes its anchor.

Status precedence:

- `revoked`: a durable family tombstone exists, even if the family has also expired.
- `active`: no tombstone, a future family deadline and at least one unspent, unexpired refresh token.
- `expired`: neither of the above, including an empty family or one containing only spent/expired tokens. This is refresh usability, not proof a token was delivered to a browser; an interrupted rotation may leave an unreturned successor.

Status uses PostgreSQL's statement transaction time. Keep database/application clocks synchronized. `expiresAt` reports the family ceiling, not a guarantee that the family is active until then.

The public `@CurrentSession()` decorator exposes the authenticated provider's session object. In the pinned `JwtBearerProvider`, this is the verified JWT claim set; `@CurrentUser()` supplies the current database user. We validate the server-generated `sid` UUID from that context, never decode unverified claims or accept client identity. Rotation preserves `sid`. A supported signed token without `sid` has no current row; it does not gain an inferred identity from cookies or input. Here “current” means the bearer token's login, which can differ from a browser cookie after another tab logs in. Browsers should keep access and refresh credentials in sync.

Targeted revocation uses one `INSERT … SELECT … WHERE user_id = authenticated_user AND session_id = requested_id ON CONFLICT DO NOTHING`. Ownership and tombstone insertion are atomic; refresh rows and replay evidence remain intact. Unknown, foreign and already-revoked UUIDs return the same 204. Cookie cleanup is independent of the bearer sid: the presented opaque cookie is SHA-256 hashed using the existing base64url storage format, then matched to its persisted token and family. Both persisted owner IDs must match the authenticated user and the family must match the requested session UUID. Only that match clears the cookie, including repeat revocation and spent/expired tokens still present in storage. Missing, malformed, unknown, overlong and foreign-user cookies are preserved. For bearer A with cookie B, revoking A preserves B; revoking owned B clears B. The lookup does not consume tokens or authorize revocation; the atomic owner predicate remains authoritative. Cleanup describes the cookie presented with this request; browsers still need to coordinate concurrent authentication requests across tabs. The safe `auth.session.revoked` audit event is emitted only after a new tombstone was inserted; it deliberately includes no actor/session IDs, PII, claims or credentials. This minimal event does not provide identity-level audit attribution.

Logout-all delegates to public `TokenService.revokeAll(authenticatedUser.id)` and clears the refresh cookie. It preserves the user-row lock ordering described above: a new login ordered after logout-all can survive, while any successor of an earlier family stays revoked. Targeted revocation also covers successors saved before or after the tombstone. A concurrent refresh may already have returned an access JWT when revocation commits. **Existing access JWTs, including those used for session administration, can remain valid for up to 15 minutes.** Deleted accounts are rejected on the next bearer lookup. Logout-all is not an account lockout.

All session responses, including authentication, validation, CSRF and storage errors, use `Cache-Control: no-store`. The mutations keep native CSRF checks and exact trusted-Origin enforcement. Cookie deletion uses the same HttpOnly/Secure/SameSite=Lax/Path=/ scope with no Domain. Database failures return a generic 503 without clearing a retryable cookie or logging SQL parameters. No schema migration or new environment setting is required for PR-07. Existing same-site browser and retention limitations still apply.

Evidence: public declarations `decorators/current-session.decorator.d.ts` and `jwt/jwt-bearer.provider.d.ts` in installed `@nestjs/authentication@0.1.1`, checked against the [official authentication guide](https://docs.nestjs.com/security/authentication). See [PR-07 verification](pr-07-verification.md) for HTTP, database and concurrency results.

## Retention and operational limits

PR-09 account workflows live in UsersModule. Password change verifies the current password through `PasswordsService`, then compares the verified hash under the user lock and commits the replacement and other-family tombstones in one transaction. Only an owned usable family established from the verified bearer sid is preserved; otherwise all are revoked. The endpoint leaves the browser cookie untouched, including bearer/cookie mismatches. Current-family rotation/replay detection remains unchanged, and already-issued access JWTs may still work until expiry.

To close stale-password login races, AuthService carries the verified credential hash through a request-local `AsyncLocalStorage` precondition on its store while calling public `TokenService.issue`. The store checks that hash against the locked user row before saving. No hash enters token claims or logs. A first login saved before password change is revoked with the other existing families; one verified with the old hash but ordered after the change fails 401. Registration reuses this verified-login path. Future password-login adapters must use the same precondition rather than call `TokenService.issue` directly.

Account deletion writes all owned family tombstones before hard-deleting the user in the same user-first transaction. Existing FKs cascade families and token hashes; tombstones have no FK and remain. A waiter cannot reinsert auth state for a deleted user; subsequent JWT lookup rejects it, including after restart. Self-deletion clears the configured refresh cookie only after commit; admin deletion leaves the administrator cookie alone. Full contracts and concurrency tradeoffs: [Users API](users.md).

Keep spent tokens and tombstones through the absolute family deadline so replay detection remains effective. A failed/interrupted rotation can leave an unreturned successor; do not infer delivery from an unspent row. There is no automatic cleanup during startup or refresh and no scheduler in core. Operators should run a reviewed, bounded maintenance job outside request handling; a conservative policy is to retain known families until **7 days after** their deadline, then remove those families (cascading tokens) and only their corresponding tombstones in a transaction. Select a limited batch of known family IDs, lock rows consistently with the user-first order, and delete tombstones only for that batch. Never age out an unknown-family tombstone by timestamp alone: its safe expiry bound is unknown. **Account-deletion tombstones are retained indefinitely**, since cascades remove their family's deadline; changing this requires an explicit safe operator retention policy.

Without that maintenance process, auth tables grow. Monitor volume and clock synchronization; budget scrypt memory/threadpool capacity. General rate limiting, abuse controls and security hardening remain PR-10. The starter is not yet the final public-production release. Registration's user insert and token issue are separate operations: if token storage fails after user creation, the user remains persisted and can retry via login. No misleading rollback or success is reported.

## Tests

```sh
pnpm test
pnpm test:integration
bash scripts/verify-compose.sh
```

The integration suite uses real migrated PostgreSQL and executes every official `authenticationStoreContract(..., { contracts: ['refreshTokens'], concurrent: true })` case. The harness uses `user-<uuid>` identifiers; a test-only fixture adapter creates actual UUID users and maps only those fixture IDs at the boundary. All contract reads/writes/revocations/consumes use the real production store and pooled connections. The factory does not replace storage with mocks. Fault-injection tests separately simulate outages after exercising normal operations on PostgreSQL.

For an actual browser check with a disposable database:

```sh
pnpm build:test
node .test-dist/test/manual/auth-browser.js
# Open the printed localhost URL, click Run browser verification, then Ctrl-C.
```

This checks credentialed registration/login, access-only JSON, HttpOnly visibility, automatic Secure-cookie sending/replacement, protected bearer access, no-store and cookie deletion. The fixture is excluded from production output. CI runs the HTTP/security/contracts/Compose suites; the interactive browser check is manual. See [PR-06 verification](pr-06-verification.md) for executed evidence and browser/platform limits.

References: [ADR-001](adr/001-auth-transport.md), [ADR-002](adr/002-auth-session-model.md), [official Nest authentication](https://docs.nestjs.com/security/authentication), [native CSRF](https://docs.nestjs.com/security/csrf), and the pinned package's installed public declarations/source.
