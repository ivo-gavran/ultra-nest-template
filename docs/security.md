# Security

PR-10 hardens the HTTP edge without replacing the native NestJS 12 security
controls. Authentication, authorization, CSRF, CORS, the `__Host-refresh`
cookie, PostgreSQL refresh rotation and guard order are unchanged; this page
documents what was added and the operational limits that remain.

## Gap summary

Already present before PR-10: `app.useSecurityHeaders()`, native CSRF
protection, exact-origin credentialed CORS, `BrowserOriginGuard`, secure
cookie flags, `Cache-Control: no-store` on auth/users, generic auth errors,
sanitized database errors, deny-by-default authorization with
AuthenticationModule registered before AuthorizationModule, and Swagger
disabled by default in production.

Added by PR-10: global and stricter rate limiting (`@nestjs/throttler`),
validated reverse-proxy trust, explicit request body caps, and this
documentation. No new migration, no Redis, no custom throttling framework.

## Rate limiting

`@nestjs/throttler@6.7.1` (peer range includes `@nestjs/common`/`core`
`^12.0.0`; verified against installed 12.1.3 typings) is registered through
`SecurityModule`, imported **before** AuthModule so its `APP_GUARD` runs
before authentication/authorization (429 precedes credential checks and any
scrypt work). Three named limiters run on every request:

| Limiter   | Default               | Applies to                                                                           |
| --------- | --------------------- | ------------------------------------------------------------------------------------ |
| `global`  | 100 / 60 s per IP     | Every route, public and authenticated                                                |
| `auth`    | 5 / 60 s, 5 min block | Auth controller per IP + hashed email; sessions per user/IP; refresh/logout included |
| `account` | 3 / 60 s per user     | Password change and admin user update/delete only                                    |

Other Users mutations (profile update, account deletion, session revoke,
logout-all) are deliberately limited by `global` + `auth` only: they are no
more scrypt-expensive than ordinary requests, and a destructive operation
must not be DoS-lockable through a tiny per-account bucket. Login and
registration use a tracker of `clientIP:sha256(normalizedEmail)` so
nonexistent-account attempts throttle identically and no raw email enters a
key or response; without a string email the tracker falls back to the client
IP. Password change/admin mutations track the authenticated user ID (never a
client-supplied ID), falling back to IP. An attacker sharing a victim's IP
can still consume that IP's bucket — that is inherent to IP limiting and is
why no hard account lockout exists: a throttled legitimate user simply waits
for the window/block to expire.

Responses carry `X-RateLimit-Limit-<name>`, `X-RateLimit-Remaining-<name>`
and `X-RateLimit-Reset-<name>` (seconds); blocked responses carry
`Retry-After-<name>` and a generic `429 Too Many Requests` body. Throttling
errors never echo submitted values.

Configuration (all validated at startup; invalid values fail fast):

| Variable                    | Default  | Range / meaning                           |
| --------------------------- | -------- | ----------------------------------------- |
| `RATE_LIMIT_GLOBAL_LIMIT`   | `100`    | 1–100000 requests per window per IP       |
| `RATE_LIMIT_GLOBAL_TTL_MS`  | `60000`  | 1000–3600000 ms window                    |
| `RATE_LIMIT_AUTH_LIMIT`     | `5`      | 1–10000                                   |
| `RATE_LIMIT_AUTH_TTL_MS`    | `60000`  | window                                    |
| `RATE_LIMIT_AUTH_BLOCK_MS`  | `300000` | block duration after exceeding auth limit |
| `RATE_LIMIT_ACCOUNT_LIMIT`  | `3`      | 1–10000                                   |
| `RATE_LIMIT_ACCOUNT_TTL_MS` | `60000`  | window                                    |

### Multi-instance deployments

The default storage is the package's in-memory `ThrottlerStorageService`:
**limits are per process and are not shared across replicas.** With N
replicas behind a load balancer, effective limits are up to N× the configured
values, and a client pinned to one replica still sees exact limits. This is
documented behavior, not cluster-wide enforcement.

For shared enforcement implement the package's public `ThrottlerStorage`
contract — a single method
`increment(key, ttl, limit, blockDuration, throttlerName)` returning
`{ totalHits, timeToExpire, isBlocked, timeToBlockExpire }` — backed by your
shared store (for example Redis with an atomic increment/expire script), and
pass it as `storage` in the `ThrottlerModuleOptions` returned by
`throttlerOptions()` in `src/modules/security/security.module.ts`. Redis is
not a core dependency; keep the single-instance in-memory default unless you
operate multiple replicas. Shared storage adds a network dependency to every
request: fail closed (429/503) rather than silently disabling limits if it is
unavailable, and monitor its latency.

## Reverse proxy trust (`TRUST_PROXY`)

Default `TRUST_PROXY=false`: Express ignores `X-Forwarded-For`/`Forwarded`,
`req.ip` is the socket peer, and throttling keys cannot be spoofed with
forwarding headers (covered by integration tests).

Set it only when every request reaches the app through known proxies:

- Hop count `1`–`10` (e.g. `1` for one load balancer), or
- Comma-separated IPs/CIDRs and/or Express presets `loopback`, `linklocal`,
  `uniquelocal` (e.g. `loopback`, `10.0.0.0/8,172.16.0.0/12`).

`true` is rejected at startup; there is no blanket trust. Supported
production topology: internet → TLS-terminating proxy/LB (only hop allowed
to reach the app; network policy must prevent direct client access) → app
with `TRUST_PROXY` naming exactly that proxy. If clients can reach the app
directly while proxy trust is enabled, forwarded headers become spoofable —
do not deploy that way. Without a proxy, leave the default.

## Request body limits

`REQUEST_BODY_LIMIT_BYTES` (default `16384`, range 1024–1048576) caps JSON
and URL-encoded bodies via Express's own parsers (`app.useBodyParser`),
registered because the app is created with `bodyParser: false` so the
capped parsers are the only ones. Oversized bodies return **413** before
routing, guards or Zod validation; normally sized payloads keep the existing
strict Zod behavior, and malformed JSON returns a generic 400 without
echoing the body. The limit applies to auth and users endpoints (all use
these parsers).

## Browser security (unchanged, verified)

- `app.useSecurityHeaders()` and native CSRF protection stay enabled.
- CORS: exact `AUTH_TRUSTED_ORIGINS`, credentials on, methods
  GET/POST/PATCH/DELETE/OPTIONS; wildcards with credentials are impossible
  because origins are validated exact HTTPS (loopback HTTP in dev only).
- `BrowserOriginGuard` still rejects missing/foreign `Origin` on mutations.
- `__Host-refresh` keeps HttpOnly/Secure/SameSite=Lax/Path=/ with no Domain.
- Auth and users responses keep `Cache-Control: no-store`.
- Swagger stays disabled by default in production (`SWAGGER_ENABLED`).

## Sensitive data policy

Nothing in the request path logs `Authorization`, `Cookie`/`Set-Cookie`,
tokens, passwords, hashes, request bodies or PII. The only application log
event remains `auth.session.revoked` with no identifiers. Database and auth
errors are mapped to generic messages at service/repository boundaries;
public errors never contain SQL, parameters, causes or stack traces.
Throttler keys are SHA-256 hashed by the guard and never logged. Structured
logging, correlation IDs, Sentry and OpenTelemetry are PR-12, not PR-10.

## Password hashing resources

Production scrypt remains `logN=17, r=8, p=1` (~128 MiB per concurrent
derivation on the libuv threadpool) — never weakened. Rate limiting runs in
the guard phase, **before** any hashing/verification, bounding concurrent
derivations per client. Registration performs one hash (`UsersService.create`)
followed by one verification (the login path); the duplicate hash was
reviewed and kept: registration intentionally reuses the verified-login path
so the PR-09 stale-password precondition (`withVerifiedPassword`, user-row
lock ordering, compare of the verified hash under lock) protects the first
token issue exactly like a login. Removing the verify would either bypass
that credential-version check or require a new internal issue path — not
worth one derivation. Operators must still budget memory: sustained
multi-client registration/login load is bounded by global limits per IP, but
provision at least ~128 MiB × expected concurrent derivations plus pool
headroom, and consider lower per-IP auth limits behind shared NATs.

## Remaining limitations

- In-memory throttling is per-process (see above); no distributed limiter,
  account lockout, CAPTCHA, or bot management in core.
- Access JWTs remain valid until expiry (15 min) after refresh revocation,
  password change or logout-all (ADR-002).
- IP-based limits are weak behind carrier-grade NAT and strong only with
  correct proxy trust; hashed-email keys mitigate credential stuffing per
  account without revealing account existence.
- Registration conflict responses can reveal email availability (documented
  in `docs/authentication.md`); enumeration-resistant registration UX is out
  of scope.
- No WAF/TLS termination in core; deploy behind a TLS-terminating proxy.

See [PR-10 verification](pr-10-verification.md) for executed evidence.
