# Authorization and ownership

PR-08 integrates the PR-00-verified `@nestjs/authorization@0.1.0`. It uses the package's public `AuthorizationModule`, `@Policy()` and `@Can()` APIs, default user resolution and global guard. There is no custom guard, permission database or general policy engine.

## Guard order and defaults

`AppModule` imports `AuthModule` before `AppAuthorizationModule`. Nest scans the former's `AuthenticationModule` before the latter's `AuthorizationModule.forRoot()`, so both singleton global guards run in that order. Do not import the authorization composition module earlier through another feature, disable either global guard or replace authentication with a later `app.useGlobalGuards()` call. The package validates known authentication/authorization ordering at startup.

Authentication verifies the bearer JWT and loads the current user from PostgreSQL. Authorization's default HTTP user resolver reads that authenticated `request.user`. Policies accept the existing `PublicUser | null` type; they never take the role or requesting user ID from query strings, bodies, route parameters or JWT role claims. Database role changes affect the next request even with the same JWT. Decisions already in flight use the user loaded for that request; this is not a lock on concurrent role changes.

- Missing, malformed, expired, wrongly signed and deleted-account credentials fail authentication with 401 before the authorization guard evaluates permissions.
- A valid ordinary user denied an administrative permission receives the native 403 response, without policy names or resource details.
- An undeclared route is denied for **both users and administrators**. There is no global administrator override.
- `@Public()` retains the existing intentionally public routes and is recognized by both packages. Do not add it to bypass a policy failure.
- `@Can.Anyone()` is not used in this application. It bypasses authorization requirements while retaining authentication behavior; do not substitute it for a concrete permission.

## Explicit abilities

| Policy / ability           | Guest  | user    | admin   | Resource constraint                               |
| -------------------------- | ------ | ------- | ------- | ------------------------------------------------- |
| `SessionsPolicy.listOwn`   | Denied | Allowed | Allowed | SQL uses authenticated owner ID                   |
| `SessionsPolicy.revokeOwn` | Denied | Allowed | Allowed | Atomic owner-filtered tombstone INSERT            |
| `SessionsPolicy.logoutAll` | Denied | Allowed | Allowed | Authenticated owner's families only               |
| `UsersPolicy.readSelf`     | Denied | Allowed | Allowed | Read only the verified current user               |
| `UsersPolicy.manage`       | Denied | Denied  | Allowed | Only operations explicitly declaring this ability |

Unknown roles fail closed. `UsersPolicy` prepares the small role checks for PR-09; PR-08 adds **no users or administrative production endpoints**. The administrative and undeclared route examples exist only in the PostgreSQL test fixture. Ordinary self-access does not imply permission to read an arbitrary user's record. Session permissions do not give administrators access to other users' sessions.

## Protecting a new endpoint

1. Add a focused method to the feature policy, accepting `PublicUser | null` and returning a boolean. Use `@Policy()` and register the class as a provider; the official module discovers registered policy providers. Keep singleton policies stateless.
2. Add `@Can(PolicyClass, 'ability')` to each protected route. Its method name, user argument and any resolver arguments are checked against the policy's TypeScript signature. Missing registrations fail bootstrap; missing route declarations deny access.
3. Use `@CurrentUser()` to obtain the verified database-loaded principal. Use its ID in service/repository predicates. Validate transport inputs with explicit strict Zod schemas as before.
4. Document bearer auth and 401/403 outcomes, then test guest, permitted/forbidden roles, undeclared routes and resource isolation with PostgreSQL where applicable.

For example, a future self-read handler can declare `@Can(UsersPolicy, 'readSelf')` and return the public user supplied by `@CurrentUser()`. It must not treat an arbitrary `:userId` as that identity. An administrative users operation must explicitly declare `@Can(UsersPolicy, 'manage')`; unrelated policies are unaffected by admin status.

`@Can()` runs before validation pipes. Avoid loading records or trusting unvalidated IDs inside a decorator resolver. If permission depends on a record that must first be loaded, enforce it in the application service using an appropriate record-aware policy through the public `AuthorizationService.authorize()` API. Keep foreign/missing responses safe, and for a subsequent write retain an owner/version predicate in the SQL statement or an appropriate transaction lock. A prior in-memory ownership check alone is not sufficient for mutable resources. The package maps service authorization denials inside handlers to native HTTP errors; do not add an exception wrapper that exposes policy arguments.

## Existing session ownership example

The three session handlers declare separate `SessionsPolicy` abilities. Their workflow still takes identity from `@CurrentUser()`, not a supplied user ID. Authorization permits the operation category; the existing database predicates enforce the resource boundary:

- Listing and cursor lookup both filter `user_id = authenticated_user.id`.
- Targeted revoke uses one owner-filtered `INSERT … SELECT … ON CONFLICT DO NOTHING`, so the ownership decision and durable revocation are atomic. It returns the same 204 for foreign, unknown and already-revoked IDs. There is no preloaded-resource check followed by an unscoped write.
- Cookie cleanup hashes the presented cookie and matches its persisted owner and target family; it does not infer cookie identity from the bearer sid.
- Logout-all calls public `TokenService.revokeAll` for the authenticated user and preserves the existing user-row locks, including refresh/login race behavior.

The guard does not replace these predicates. Do not remove them after adding `@Can()`, and do not add an administrator bypass to own-session operations. Strict Zod inputs, native CSRF, exact Origin checks, credentialed CORS, no-store headers and cookie flags remain unchanged. Access JWTs can remain valid for up to 15 minutes after refresh revocation, while database-backed roles and account existence are checked on each authenticated request.

## Validation and package evidence

The installed package's public exports, `Can`/`Policy` declarations, `Ability` argument types, default user resolution, guard and module registration were inspected before implementation. Its guard grants only explicit literal-true policy decisions, maps denials to native transport errors, recognizes authentication's `@Public()` and denies missing declarations. These behaviors match the [official authorization guide](https://docs.nestjs.com/security/authorization) and PR-00 spike.

Policy unit tests cover guest, user, admin and unexpected roles. HTTP tests use real bearer flows and migrated PostgreSQL, with a test-only admin/undeclared controller. Public authorization denial events prove invalid credentials stop before authorization and authenticated denials see a real principal; tests capture decision metadata only. Never log entire authorization events: they can contain users and policy arguments. No production event logging was added in this milestone.

Run `pnpm test`, then `pnpm test:integration`; these commands share a generated test directory and must run sequentially. Existing authentication, session cookie association, CSRF/CORS, storage concurrency and migration tests remain enabled. Production Swagger's exact path assertions keep test fixture endpoints out of the application contract. See [PR-08 verification](pr-08-verification.md) for executed results.
