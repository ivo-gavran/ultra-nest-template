# PR-10 verification

Branch: `feat/pr-10-security-hardening`, PR #12. Review fixes verified locally
on 2026-10-13 with Node 24.21.0, pnpm 10.33.0 and Docker 29.8.2. No PR-11
health/lifecycle functionality, migrations or dependency changes are included
in the review fixes. Final commit and GitHub Actions status are reported in
the PR/thread after push.

## Package evidence

- Installed `@nestjs/throttler@6.7.1` accepts Nest 12 peers; the app pins Nest
  12.1.3. Inspected its `ThrottlerModule.forRootAsync`, `ThrottlerOptions`,
  `ThrottlerGuard`, native IP normalization, headers and storage contract.
- Named definitions apply to every route unless skipped. The documented
  per-definition `skipIf(context)` option now scopes `auth` and `account`
  using typed `RateLimit` metadata. `global` has no skip condition and needs
  no route annotation. See [official documentation](https://docs.nestjs.com/security/rate-limiting).
- The native tracker uses Express `req.ip`, normalizes IPv4-mapped addresses
  and groups IPv6 by /64. Its SHA-256 key includes controller, handler,
  limiter and IP. Budgets are per handler, not an aggregate across the API.
- Responses use `X-RateLimit-{Limit,Remaining,Reset}-<name>`;
  blocked policies emit `Retry-After-<name>` before throwing. Tests check
  both expected and absent named headers rather than status alone.
- The package ships CommonJS while Nest 12 packages are ESM. Jest's VM loader
  can encounter a require(esm) cycle if throttler loads Nest first. Existing
  `test/setup-env.ts` preloads common/core/config/platform-express; production
  ESM needs no shim. This interoperability workaround is unchanged.

## Corrected policies and identity

The configured application's guard-order assertion is exactly
`ThrottlerGuard → AuthenticationGuard → AuthorizationGuard`. Authentication
remains before authorization. There is no custom post-auth guard, second
JWT verification, per-user tracker or email-based tracker.

| Routes                                                                                     | Applied policies (per IP, per handler)   |
| ------------------------------------------------------------------------------------------ | ---------------------------------------- |
| POST auth/register, login, refresh, logout                                                 | global 100/60s + auth 5/60s (300s block) |
| PATCH users/me/password; PATCH/DELETE users/:id                                            | global 100/60s + account 3/60s           |
| Public starter, users reads, profile update, self-deletion, session list/revoke/logout-all | global 100/60s only                      |
| Future routes without throttle metadata                                                    | global 100/60s                           |

Five login attempts exhaust the IP budget even with five different emails.
Existing and nonexistent accounts receive the same throttling behavior.
Different verified users at one IP share the account bucket; another trusted
client IP is isolated. Changing body identities, bearer tokens or admin
target IDs does not create a fresh bucket for the same handler/IP.

Proxy configuration rejects empty, signed, fractional and out-of-range CIDR
prefixes, including IPv4 and IPv6 `/0` with any host portion. Trust defaults
to false. Untrusted socket peers cannot alter identity via forwarding
headers. Trusted ingress must select a valid IP; malformed identities receive
a generic 400 before bucket creation. Address chains stop at the nearest
untrusted hop.

## Regression coverage

`test/integration/security.spec.ts`: **24 HTTP/application tests**, using the
configured Nest app, real PostgreSQL and actual migrations. Each test gets a
fresh application and in-memory throttle store, avoiding cross-test budget
leakage. Production rate defaults are exercised directly; only the global
exhaustion and block-expiry cases lower limits/windows for focused checks.
The body-cap fixture uses 2048 bytes to test 413 cheaply.

Coverage includes four successful consecutive profile reads; global-only
read exhaustion; a controller without throttle metadata; six login attempts
with different, repeated and existing-account emails; registration limits;
refresh/logout scope; every session-admin route; profile/self-deletion scope;
password and admin mutation scope; shared-IP users and different-IP isolation;
changed admin target IDs; guard order; invalid/untrusted/trusted proxy headers;
IPv6 normalization; body caps; Zod validation; generic errors; secret redaction;
CSRF, CORS, cookie attributes and no-store behavior.

`test/environment.spec.ts` checks production defaults and malformed/blanket
proxy CIDRs. Existing auth, RBAC, users and session suites run unchanged,
including PostgreSQL locking/race tests and the official
`@nestjs/authentication/testing` refresh-token store contracts with
`concurrent: true`.

## Executed checks

Results for the review fix:

- `pnpm lint` — passed, exit 0.
- `pnpm format:check` — passed, exit 0.
- `pnpm typecheck` — passed, exit 0.
- `pnpm test` — 7 suites, 132 tests passed, exit 0.
- `pnpm test:integration` — 9 suites, 161 tests passed, exit 0.
- `pnpm build` — passed, exit 0.
- `bash scripts/verify-compose.sh` — passed, exit 0: production runtime,
  auth/session/users flows, rate-limit headers, 413 caps, explicit migrations,
  persistence and clean shutdown (API 143, PostgreSQL 0).

The isolated Compose smoke already raises limits for its many sequential
functional requests (global 10000, auth/account 1000); it does not verify
production throttling thresholds. The HTTP regression suite does. Production
`.env.example`, Compose and schema defaults remain 100/5/3 per minute.

## Remaining limitations

- In-memory budgets are per process; replicas need the documented shared
  `ThrottlerStorage` backend for cluster-wide enforcement.
- Clients sharing an IP (or IPv6 /64) share budgets. There is no authenticated
  per-user isolation, per-email limit or distributed-source protection.
- Limits count requests per handler/window; they do not bound global scrypt
  concurrency. Production scrypt cost and hash-then-verify registration are
  unchanged.
- Access JWTs can remain valid until expiry after refresh revocation.
- Only the block-expiry regression waits: advertised `Retry-After-auth`
  seconds plus 100 ms for the package's real timers. Other tests do not wait
  for buckets to reset.
