# ADR-002: Device sessions backed by refresh-token families

Date: 2026-10-12. Status: accepted and implemented in v1.0.0.

## Decision

`/auth/sessions` lists our persisted bearer-login families, not `SessionService` records. The installed `TokenService` exposes issue/refresh/revoke-by-token/revoke-all, but neither list-families nor revoke-by-family-id. `TokenPair` does not expose a family id, and JWT claims do not automatically include one. Avoid pretending the cookie-session API covers this model.

Use a small `auth_token_families` table as the device-session model. Fields: internal `family_id` (text, primary key), public `session_id` (UUID, unique), `user_id`, `created_at`, `family_expires_at`, and optional bounded device label. A separate `auth_refresh_tokens` table stores the token **hash** id, family foreign key, user id, creation/expiry times, nullable `used_at`, and immutable claims JSON. `auth_revoked_families` stores durable revocation tombstones keyed by family id, with a revocation timestamp; derive revoked status by joining it, rather than maintaining two flags. Store no raw credentials. IP/user-agent retention is optional and requires a deliberate privacy/retention choice; no unbounded request metadata in claims.

Generate an application `sid` UUID on successful credential verification and pass it through `TokenService.issue(userId, { claims: { sid } })`. It is server-controlled, never accepted from a request body. `saveRefreshToken(record)` receives the package-generated `familyId` and claims before issue returns, so our store can atomically establish the mapping and persist the hash. Rotation retains the same claims. The test proves `sid` survives rotation.

The generic store contract also sends records without `sid`. Support those by generating a session id once when inserting a previously unknown family; subsequent tokens keep that mapping. Reject mismatched owner/claims for an existing family without overwriting its identity. A family insert uses conflict handling that **never clears revocation**. This uses only the public `RefreshTokenRecord` and `RefreshTokenStore` contracts.

## Listing and revocation

List only rows owned by the authenticated user, with deterministic pagination and explicit active/revoked/expired status. A login is active only if its family is unrevoked and unexpired **and** it has an unspent, unexpired refresh token; a long family deadline alone does not establish activity. Return public session ids, safe labels and timestamps, never token hashes, credentials or raw claims. Mark the current row by the verified `sid` claim. It is a display identifier, not authorization by itself.

`DELETE /auth/sessions/:id` inserts a revocation tombstone from a family SELECT with an owner predicate in SQL. Foreign and unknown ids get the same response. Revoke via an application service over our own store/table, using the same durable revocation state checked by `isRefreshTokenFamilyRevoked`. The package's public store method `revokeRefreshTokenFamily(familyId)` is also available after an ownership check, but `TokenService` has no equivalent overload. Do not call private methods. Record a safe app audit event for targeted revocation, since bypassing `TokenService.revoke` does not emit its event automatically.

Current-device logout uses the presented refresh cookie and `TokenService.revoke`. Logout-all uses `TokenService.revokeAll(authenticatedUserId)` and clears the current browser cookie. Password change can revoke all other family rows using the authenticated `sid` and user id in the predicate; the package has no refresh-family `except` option. Cookie sessions, if ever added, require their separate storage and revocation flow.

## Atomicity requirements

Implement all six public `RefreshTokenStore` methods. In particular:

```sql
UPDATE auth_refresh_tokens
SET used_at = $2
WHERE id = $1 AND used_at IS NULL
RETURNING id;
```

Exactly one concurrent caller may receive a row. Never replace this with a read followed by an unconditional update. Reads return used/expired records too, with dates restored and absent optional values represented as `undefined`; the service owns expiry/replay decisions.

Use a persistent family revocation marker, not just deletion or updates of currently existing tokens. `revokeRefreshTokenFamily` inserts into `auth_revoked_families` with `ON CONFLICT DO NOTHING`, even for a not-yet-existing family; that table therefore has no required family foreign key. It remains effective for later successor inserts. Retain the marker until no token from the family can still be accepted; never time out an unknown family's marker without establishing a safe expiry bound. Never resurrect a family during a conflict update.

Keep family creation and token insertion in one transaction. Serialize `saveRefreshToken` and `revokeUserRefreshTokens` for a user by locking that user's row with `SELECT ... FOR UPDATE` in each transaction. Logout-all then inserts tombstones for all the user's existing families before committing. A first issuance that obtains the lock afterwards is a new login and may survive; a family created before logout-all cannot survive via a later rotation. This defines the linearization order. New logins after logout-all are allowed by the package contract. Test this on pooled connections; package-level method contracts alone do not establish the app's cross-method transaction behavior.

Source inspection of 0.1.1 shows `refresh()` saves a successor **before** conditionally marking the old token used. A losing refresh can therefore leave an unreturned successor row. Family revocation must invalidate it. Failure/retry and cleanup logic must not assume every unspent row was delivered to a client. Set bounded retention/cleanup and test interrupted writes; do not purge replay evidence before the family expires.

## Required database proof

Run `authenticationStoreContract(factory, { contracts: ['refreshTokens'], concurrent: true })` from the package's exported `/testing` entry point, executing every returned case on a real pooled PostgreSQL store. The installed harness has five refresh cases, including competing consumes, revocation surviving later inserts, and competing `TokenService.refresh` calls. The integration suite executes every case against migrated PostgreSQL.

Maintain app tests for owner isolation, own/other targeted revocation, list state, restart persistence, logout-all versus rotation/first issuance, password-change revocation, account deletion, expiry and post-revocation successor insertion. Coordinate races with barriers where needed. Acceptance requires real migrations and pooled connections; passing tests on the package's in-memory default is insufficient.

Sources: installed `@nestjs/authentication@0.1.1` public `dist/interfaces/{token,refresh-token-store}.interface.d.ts`, `dist/jwt/token.service.{d.ts,js}`, `dist/testing/index.{d.ts,js}`; [official authentication guide](https://docs.nestjs.com/security/authentication). See [ADR-001](001-auth-transport.md) for JWT revocation limits and browser transport.
