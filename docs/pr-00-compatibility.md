# PR-00 compatibility report

Verified: 2026-10-12. Result: the pinned core packages install with strict peer checks, compile and pass six isolated smoke tests. The public auth APIs support the selected transport/model. PR-01 may proceed with the adjustments below; this is not production auth/database certification.

## Baseline and scope

The supplied directory contained `.nvmrc` (`24`), `.env.example`, `.gitignore` and `.DS_Store`; no package manifest, source, tests or `.git`. The three supplied planning documents were copied unchanged to the root. Only `docs/` and the standalone `spikes/pr-00/` probe were added. No application scaffold, migrations, optional extensions, commits or remote PR were created.

## Pinned and tested versions

| Component                                          | Version                   |
| -------------------------------------------------- | ------------------------- |
| Node runtime used for final checks                 | 24.5.0                    |
| pnpm                                               | 10.33.0                   |
| `@nestjs/common`, `core`, `platform-express`       | 12.1.3                    |
| `@nestjs/drizzle`                                  | 0.0.2                     |
| `drizzle-orm` / `drizzle-kit` / `pg`               | 0.45.4 / 0.31.11 / 8.23.1 |
| `zod` / `@nestjs/config` / `@nestjs/swagger`       | 4.6.6 / 12.0.1 / 12.0.2   |
| `@nestjs/authentication` / `@nestjs/authorization` | 0.1.1 / 0.1.0             |
| TypeScript                                         | 6.0.3                     |
| `reflect-metadata` / `rxjs`                        | 0.2.2 / 7.8.2             |
| `@types/node` / `@types/express` / `@types/pg`     | 24.19.2 / 5.0.6 / 8.23.1  |

Exact direct versions are in the [probe manifest](../spikes/pr-00/package.json); transitive resolution/integrity is in [pnpm-lock.yaml](../spikes/pr-00/pnpm-lock.yaml). Optional class-validator/class-transformer, microservice and websocket peers were not installed. Strict peer resolution passed. Nest/Drizzle/auth package Node minimums and Swagger's Node minimum are satisfied by the tested runtime.

## Evidence

| Surface                      | Executed proof                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config + Zod                 | `validationSchema` accepts Zod, coerces/defaults a numeric value, rejects missing required config                                                                                      |
| Request validation + Swagger | `@Body({ schema })` with global `StandardSchemaValidationPipe`; valid input 201, invalid/extra fields 400; generated OpenAPI reflects required field, minimum length and strict object |
| Drizzle + PostgreSQL driver  | Official module injects `NodePgDatabase`, query compiles, app shutdown closes `pg.Pool`; no query was sent to PostgreSQL                                                               |
| Authentication/authorization | Real bearer provider and guards: 401 guest, 403 user, 200 admin, undeclared route denied                                                                                               |
| Browser adapter/security     | Native headers/CSRF plus strict Origin check; trusted CORS credentials; secure refresh cookie; no refresh token in JSON; logout clears cookie and revokes refresh                      |
| Token lifecycle              | Rotation preserves application `sid`; replay/racing refresh revokes family successors; revoke-all rejects subsequent refresh (test-mode in-memory defaults only)                       |
| Production startup           | Missing `RefreshTokenStore` rejects startup with `NODE_ENV=production`                                                                                                                 |
| Hashing                      | Public package scrypt hasher verifies correct/rejects wrong password; reduced cost confined to test                                                                                    |

The official `/testing` contract harness is exported and selected with `contracts: ['refreshTokens'], concurrent: true`; its five refresh cases were inspected. They were **not run against PostgreSQL**. The production implementation must run every returned case.

## Commands and outcomes

Commands ran from `spikes/pr-00` unless stated otherwise. The shell/PATH initially resolved Node inconsistently (24.5.0 in the first environment check, 22.22.3 inside initial pnpm runs). Final checks explicitly selected the installed Node 24 runtime:

```sh
export PATH=/Users/ivo_gavran/.nvm/versions/node/v24.5.0/bin:$PATH
node --version
pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir /private/tmp/nest-pr00-pnpm-store
pnpm typecheck
pnpm test
pnpm exec drizzle-kit --version
```

- Node: `v24.5.0`; frozen installation: exit 0; typecheck: exit 0.
- `pnpm test` runs `pnpm build` (`tsc`) then `node --test dist/*.test.js`: build exit 0, **6 passed, 0 failed, 0 skipped**.
- Drizzle CLI: exit 0, Kit 0.31.11 / ORM 0.45.4. No generate/migrate command was run.
- Initial install: `pnpm install --ignore-scripts --store-dir /private/tmp/nest-pr00-pnpm-store`, exit 0. Only warnings were initial Node engine selection and two deprecated Drizzle Kit transitive dependencies (`@esbuild-kit/core-utils`, `@esbuild-kit/esm-loader`). No dependency lifecycle scripts were executed.
- Version/peer queries used `npm view <package> version peerDependencies engines --json --fetch-retries=0 --fetch-timeout=15000 --cache /private/tmp/nest-pr00-npm-cache`; TypeScript 6 and Node 24 types were selected with `npm view typescript@6 version --json` and `npm view @types/node@24 version --json` (same cache). Registry access needed sandbox network escalation after `ENOTFOUND`.
- Initial typecheck caught a widened duration string in the probe; explicit `AuthenticationModuleOptions` fixed it. Initial HTTP test failed at loopback `listen` with sandbox `EPERM`; an approved run outside that socket restriction passed. Final updated tests passed again.
- `docker info --format '{{.ServerVersion}}'`: exit 1; Docker socket missing/daemon not running. No database tests, migrations or Testcontainers runs were claimed.
- Formatting used transient `prettier@3.9.10` via `npm exec --yes --ignore-scripts --cache /private/tmp/nest-pr00-npm-cache --package=prettier@3.9.10 -- prettier --write <new files>`; no formatter dependency added to the application.
- Root `pnpm lint`, application test scripts and CI are not available yet; they belong to PR-01/04. Probe TypeScript is strict with `skipLibCheck: true`, so this verifies application API usage, not every optional third-party declaration.

## Required plan adjustments and open gates

1. Pin TypeScript **6.0.3**, not current latest 7.0.2: Swagger 12.0.2 declares `^5.5.0 || ^6.0.0`. Use ESM (`type: module`, explicit `.js` local import paths) for the tested Nest 12 stack. Configure the planned Jest toolchain accordingly in PR-01; it was not evaluated here.
2. Preserve the official Drizzle integration; no fallback is justified by the probe. Use `ConfigModule.validationSchema`, native request schemas, `useSecurityHeaders()` and `enableCsrfProtection()` as verified. Some original documentation URLs have moved: use the sources below.
3. Follow [ADR-001](adr/001-auth-transport.md): browser cookie transport is application code; explicitly set the refresh-family absolute lifetime; require an allowed Origin for browser cookie mutations. Register only the stores enabled features need, from singleton constructors, before initialization.
4. Follow [ADR-002](adr/002-auth-session-model.md): add the bearer-family/session mapping and durable revocation tombstones in PR-06, before the PR-07 listing API. Atomic consumption alone is insufficient. Prove pooled PostgreSQL race behavior and ownership checks before accepting auth.
5. In PR-01 select a currently maintained Node 24 LTS patch for development/CI and rerun the smoke. **24.5.0 is the installed test runtime, not a recommendation for production patch selection.** Do not mistake `.nvmrc` containing only `24` for an exact pin.

No package/API incompatibility blocks the next bootstrap milestone with these pins. Database persistence, full browser enforcement, error/cookie expiry handling, migrations, production-cost hashing, Jest compatibility and restart/race coverage remain explicitly unverified later-milestone gates.

## Sources

Primary evidence is the installed public declarations and implementations in the pinned packages (specific paths in the ADRs), lockfile and executable probe. Official documentation checked: [authentication](https://docs.nestjs.com/security/authentication), [authorization](https://docs.nestjs.com/security/authorization), [Drizzle](https://docs.nestjs.com/data/drizzle), [validation](https://docs.nestjs.com/application/validation), [configuration](https://docs.nestjs.com/application/configuration), [Swagger](https://docs.nestjs.com/openapi/introduction), [security headers](https://docs.nestjs.com/security/helmet), [CSRF](https://docs.nestjs.com/security/csrf).
