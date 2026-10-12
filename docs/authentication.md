# Authentication

PR-06 uses `@nestjs/authentication@0.1.1` through its public `AuthenticationModule`, `TokenService`, `JwtBearerProvider`, `AuthenticationStorage` and `RefreshTokenStore` APIs. The existing package-backed `PasswordsService` handles scrypt. There is no custom JWT implementation, session-cookie provider or in-memory production store.

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

Every endpoint requires an explicit allowed `Origin`, including same-origin browser requests. Missing, `null`, foreign or lookalike origins receive 403. Native Nest CSRF protection and security headers run before handlers; CORS uses the same exact allowlist with credentials enabled. An allowed preflight does not replace the mutation's Origin check. The current CORS methods cover GET/POST/OPTIONS; later milestones must deliberately extend them when adding other HTTP verbs.

Registration always creates a `user`. Login uses the dedicated internal credentials projection and performs package verification even when the account is absent. Wrong/unknown credentials produce the same generic 401. Strict schemas reject client-supplied roles, hashes, session IDs and tokens. Duplicate registration returns a generic 409; like other registration conflict responses, this can reveal email availability. If account-enumeration resistance is required, redesign the registration UX in a later account lifecycle milestone.

Register/login/refresh return only `{ accessToken, expiresIn }`. Keep the access token in browser memory, send it as `Authorization: Bearer …`, and discard it on logout. Do not persist credentials in localStorage. The response sets `Cache-Control: no-store`. Browser code must use `credentials: 'include'` for cross-origin auth calls.

The refresh token appears only in `Set-Cookie: __Host-refresh=…`, with **HttpOnly, Secure, SameSite=Lax, Path=/** and **no Domain**. `Expires` comes from the persisted token record, not the access token's `expiresIn`; rounding to cookie-date precision cannot extend its life. The cookie flags stay secure in development. Logout and invalid/expired/replayed refresh clear the same cookie scope with a past expiry. Unknown/malformed logout credentials still return 204; a storage failure returns generic 503 and does not claim successful revocation or delete a retryable cookie.

Supported topology: an HTTPS frontend and API on the same site (for example `app.example.com` and `api.example.com`), or a same-origin HTTPS reverse proxy. Include all legitimate initiating origins, including the API origin if its Swagger/browser UI will initiate auth requests. Truly cross-site embedding/frontends are not supported by this Lax-cookie adapter. No `SameSite=None` fallback or insecure-cookie switch is provided. Local browsers may treat `http://localhost` as a Secure-cookie exception; use local HTTPS if yours does not. The default Compose HTTP port is intended for a local proxy or non-browser smoke checks; it is not a production TLS terminator.

## Guards and credential separation

The package's global authentication guard stays enabled. Only the four auth mutations and the original starter routes are marked `@Public()`. A test-only protected controller verifies bearer behavior without adding an extra production endpoint. New application routes are protected by default. `BearerProvider` validates signed claims and loads the current user from PostgreSQL on every authenticated request, rejecting deleted accounts and avoiding immutable role claims. RBAC/policies remain PR-08.

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

## Retention and operational limits

Keep spent tokens and tombstones through the absolute family deadline so replay detection remains effective. A failed/interrupted rotation can leave an unreturned successor; do not infer delivery from an unspent row. There is no automatic cleanup during startup or refresh and no scheduler in core. Operators should run a reviewed, bounded maintenance job outside request handling; a conservative policy is to retain known families until **7 days after** their deadline, then remove those families (cascading tokens) and only their corresponding tombstones in a transaction. Select a limited batch of known family IDs, lock rows consistently with the user-first order, and delete tombstones only for that batch. Never age out an unknown-family tombstone by timestamp alone: its safe expiry bound is unknown. Account-deletion tombstones therefore also need an explicit retention decision.

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
