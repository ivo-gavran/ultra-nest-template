# ADR-001: Browser refresh-cookie transport

Date: 2026-10-12. Status: accepted and implemented in v1.0.0.

## Decision

Keep JWT access tokens in browser memory and send them as bearer credentials. Use the public `TokenService.issue`, `refresh`, `revoke` and `revokeAll` APIs from `@nestjs/authentication@0.1.1`. Our controller owns refresh-cookie transport; no undocumented hooks or `SessionCookieProvider` are needed. `JwtBearerProvider.validate` loads the current user and rejects deleted accounts; do not encode mutable roles as permanent family claims.

The browser endpoint returns only `{ accessToken, expiresIn }` and sets `Cache-Control: no-store`. It must never return the refresh token in JSON, URLs or logs. Refresh and logout read it with Nest's `@Cookies('__Host-refresh')`; Express `response.cookie` and `clearCookie` write/delete it using `@Res({ passthrough: true })`. No cookie-parser dependency is necessary for this decorator on the tested Nest version.

Use `__Host-refresh`, `HttpOnly`, `Secure`, `Path=/`, no `Domain`, and `SameSite=Lax`. Same-site deployments are the initial supported topology. A truly cross-site frontend needs an explicit `SameSite=None; Secure` configuration plus browser testing for third-party-cookie restrictions. HTTPS is required outside localhost development. Do not silently weaken the production cookie configuration.

Access lifetime is 15 minutes. Explicitly set both refresh `ttl` and `absoluteTtl` to 7 days initially, so rotation cannot keep a login alive indefinitely. Cookie expiry must not outlive the persisted token expiry and must respect the family deadline. The application reads expiry through its PostgreSQL store/model; `TokenPair.expiresIn` describes the **access** token, not the refresh token. Deletion repeats the same cookie scope and flags, omitting a positive `maxAge`.

## Request protection

Enable `app.enableCsrfProtection({ trustedOrigins })` and `app.useSecurityHeaders()` before initialization. Configure CORS with the same exact origin allowlist and credentials. Cookie-based login, registration, refresh and logout additionally require an explicit allowed `Origin`, including the API origin when a same-origin frontend is supported. Missing/null/untrusted origins fail closed for these browser endpoints. This closes the native middleware's intentional allowance for requests without browser-origin headers. CORS alone is not CSRF protection. Keep state changes out of GET/HEAD handlers.

Separate any future non-browser token endpoints by explicit route/schema; never switch to returning refresh tokens based on a caller-supplied flag on a browser route. Do not add these endpoints until required.

## Persistence and lifecycle

For bearer-only authentication with access tokens and rotating refresh tokens, the required production contract is `RefreshTokenStore`. Register its singleton provider through `AuthenticationStorage.registerSource({ refreshTokens: this })` in its constructor. The registry locks at module initialization or first storage access. Do not set `allowInMemoryStorage` in production. Other enabled features may require additional contracts; installing the package alone does not require all six.

Import `AuthenticationModule` before `AuthorizationModule`. Keep global guards enabled, use `@Public()` only on deliberately public endpoints, and require policies elsewhere. Application tests verify guest 401, ordinary-user 403, admin 200 and denial on a route without a policy.

Refresh replay revokes the entire family. The browser must serialize refresh attempts, including across tabs where possible; a retry after a lost response can force another login. Treat this as an explicit strict-rotation tradeoff, not an opportunity to bypass replay detection. On invalid/expired refresh, clear the cookie and return a generic 401; on a storage outage return a generic server error without pretending the logout/refresh succeeded.

Revoking refresh credentials does not invalidate already issued JWTs. They may remain usable until expiry (up to 15 minutes), subject to the application's current-user lookup. Immediate per-session JWT revocation is outside core scope.

## Evidence and maintenance requirements

Real PostgreSQL integration and E2E tests cover storage contracts, concurrency,
failure handling, cookie expiry, deleted-user rejection and exact origin
validation. The [authentication guide](../authentication.md#tests)
describes the automated suites and manual browser fixture. Automatic browser
cookie enforcement remains a manual check; localhost evidence does not certify
all browser engines, production TLS or cross-site deployments.

Preserve deleted-account checks before refresh rotation and at the response
boundary; eventual bearer validation alone is insufficient.

Sources: [official authentication guide](https://docs.nestjs.com/security/authentication), [CSRF guide](https://docs.nestjs.com/security/csrf), and installed `dist/jwt/token.service.{d.ts,js}`, `dist/storage/authentication.storage.js`, `dist/interfaces/refresh-token-store.interface.d.ts` under the pinned authentication package. The detailed storage and transport decisions above come from inspecting those installed APIs and the application tests, not assumptions about tutorial endpoints.
