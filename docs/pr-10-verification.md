# PR-10 verification

Branch: `feat/pr-10-security-hardening` (from `main`). Executed locally on
Node 24.21.0 / pnpm 10.33.0 with Docker available. GitHub CI status is
reported in the pull request, not asserted here.

## Package evidence

- `@nestjs/throttler@6.7.1` installed (exact). Its peer range is
  `@nestjs/common`/`@nestjs/core` `^7–^12`, matching pinned 12.1.3.
  Installed typings inspected before implementation:
  `ThrottlerModule.forRootAsync`, `ThrottlerOptions { name, limit, ttl,
blockDuration, getTracker, generateKey, setHeaders }`, `Throttle`/
  `SkipThrottle` (route `getTracker` override semantics in
  `throttler.guard.js`), `ThrottlerGuard` headers (`X-RateLimit-*`,
  `Retry-After-*` only on blocked responses), `ThrottlerStorage`
  (`increment(key, ttl, limit, blockDuration, throttlerName)`), and the
  default in-memory `ThrottlerStorageService`.
- Discrepancy found: 6.7.1 ships CommonJS output without
  `"type": "module"` (Nest 12 core packages are pure ESM). Under Jest's VM
  loader, whichever Nest ESM package throttler requires first trips Node's
  require(esm) cycle check. Production ESM (`node dist/main.js`) is
  unaffected. The test setup preloads `@nestjs/common`, `@nestjs/core`,
  `@nestjs/config` and `@nestjs/platform-express` (see `test/setup-env.ts`)
  so no production shim is needed.
- Second discrepancy: throttler's per-route `@Throttle` tracker options are
  indexed `THROTTLER_TRACKER + name`, and header writes carry the throttler
  suffix (default `default`; ours are `global`/`auth`/`account`). Header
  assertions in tests were adjusted to the installed behavior.

## Design decisions

- Guard order: `SecurityModule` is imported before `AuthModule`, so its
  throttler `APP_GUARD` precedes authentication/authorization (AGENTS.md
  order preserved; 429 precedes credential checks and scrypt).
- Tracker granularity is constrained by the package: each route has one
  tracker per named throttler. Register/login therefore use
  `clientIP:sha256(normalizedEmail)` as the single `auth` tracker (covers
  both per-IP and per-account; collision space documented in
  `docs/security.md`). Password change/admin mutations track the
  authenticated user ID; other mutations intentionally use global+auth only.
- App is created with `bodyParser: false` and capped Express parsers are
  registered in `configureApplication` (`useBodyParser`), so oversized
  bodies get 413 from body-parser before Nest's exception filter — no raw
  body is logged (Nest's default error logging was already off for these
  paths; verified by test).
- `TRUST_PROXY` schema accepts only `false`, hop counts 1–10, or IP/CIDR/
  preset lists; `true` is rejected at startup.
- Registration hash-then-verify was **kept**: eliminating the verify would
  bypass the PR-09 verified-hash precondition on first token issue.
  Documented in `docs/security.md`; no scrypt parameters changed.

## Tests

New: `test/integration/security.spec.ts` (13 tests, 2 describe blocks)
covering rate-limit headers, below-limit success, auth-limit 429 for
existing and nonexistent accounts, registration throttling without secret
echo, window reset (bounded 2.6 s wait against 1 s TTL + 2 s block test
config), spoofed forwarding headers with proxy trust off, per-hashed-email
independence, authenticated global limiting, per-user password-change
limiting, 413 for oversized JSON and URL-encoded bodies, Zod validation
intact for normal/malformed payloads, origin/CSRF/CORS/cookie/no-store
preservation, secret/SL/stack redaction, and trusted-proxy (`loopback`)
forwarded-identity throttling.

Updated: `test/environment.spec.ts` (new defaults, TRUST_PROXY parsing and
invalid security config), `test/helpers/auth-app.ts` (optional env
overrides, generous test defaults, `bodyParser: false`),
`test/setup-env.ts` (ESM preload + generous limits for unrelated suites),
`test/app.spec.ts` (`bodyParser: false`).

Results (run before this file was finalized; re-run at PR time):

- `pnpm test` — 7 suites, 119 tests passed.
- `pnpm test:integration` — 9 suites, 150 tests passed (includes all
  pre-existing auth/authorization/users/sessions/store-contract suites).

Full gate results (`pnpm install --frozen-lockfile`, `pnpm lint`,
`pnpm format:check`, `pnpm typecheck`, `pnpm build`,
`bash scripts/verify-compose.sh`) are recorded in the PR description with
exact output; this file is updated if any of them differ.

## Docker

`compose.yaml` passes the new variables through with defaults matching the
validated application defaults; `scripts/verify-compose.sh` is unchanged
because the default limits (100/60 s global, 5/60 s auth) comfortably allow
its sequential smoke requests, and its existing register/login/refresh/
logout/users flows still exercise the hardened edge.

## Remaining risks

- Per-process in-memory limits behind multiple replicas (documented;
  shared `ThrottlerStorage` contract provided, no Redis dependency added).
- Test suite's 1 s TTL windows rely on bounded waits, not fake timers
  (throttler default storage has no injectable clock); waits are 2.6 s max.
- `load-esm`-style CJS/ESM interop for throttler under future Jest/Node
  versions may require revisiting the `test/setup-env.ts` preload.
