# PR-02 verification

Verified on 2026-10-12 using Node **24.21.0** and pnpm **10.33.0**. Branch `feat/pr-02-config-validation` starts at the fetched `origin/main`, `d49f8be` (merged PR-01).

## Behavior and implementation

- `ConfigModule` uses its native Standard Schema integration with Zod 4. The centralized schema defines typed defaults, validates ports and PostgreSQL URLs, and parses explicit boolean flags. Missing `DATABASE_URL` prevents startup, even though database connections belong to PR-03.
- `.env` loads from the working directory; process environment overrides it. Consumers read validated values through typed `ConfigService`, with later raw process-environment fallback disabled.
- Shared application setup applies `/api/v1`, the global `StandardSchemaValidationPipe` and conditional Swagger registration. Nest's exception handling remains unchanged; there is no response envelope.
- `POST /api/v1/greetings` demonstrates `z.strictObject`, `z.infer` and native `@Body({ schema })` metadata. It accepts a required string name of 1–80 characters and rejects additional properties. Successful greetings use `text/plain`, including when input contains HTML.
- Swagger derives the request schema from that same Zod schema and documents the string response. `/docs`, its assets and `/docs-json` are enabled outside production by default. `SWAGGER_ENABLED=true` or `false` overrides that default. Disabled documentation routes return 404; YAML output is disabled.

## Executed checks

| Command / check                                                                          | Result                                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile --offline --store-dir /private/tmp/nest-pr00-pnpm-store` | Exit 0; lockfile unchanged                                                                  |
| `pnpm lint`                                                                              | Exit 0                                                                                      |
| `pnpm format:check`                                                                      | Exit 0                                                                                      |
| `pnpm typecheck`                                                                         | Exit 0                                                                                      |
| `pnpm test`                                                                              | Exit 0; **3 suites, 50 tests passed**, none failed or skipped                               |
| `pnpm build`                                                                             | Exit 0                                                                                      |
| `pnpm start:dev` with synthetic development environment                                  | Server started; GET and valid POST 200, unknown property 400, UI and JSON documentation 200 |
| `pnpm start` with synthetic production environment                                       | Built server started; GET and valid POST 200, unknown property 400, UI and JSON docs 404    |
| `pnpm list class-validator class-transformer --depth Infinity`                           | Exit 0; neither package installed                                                           |
| `git diff --check`                                                                       | Exit 0                                                                                      |

The shell required the pinned Node runtime explicitly on PATH. HTTP listeners and subprocess smoke checks ran with local socket permission. Smoke servers used temporary ports and were stopped after verification.

Tests cover valid/invalid environment values, five actual bootstrap failure scenarios, `.env` loading and process override precedence, preservation of typed values after a raw environment change, valid payload boundaries, malformed JSON, unknown fields, built-in 400/404 behavior, OpenAPI required/min/max/strict-object constraints and production documentation opt-in/development opt-out. Startup error tests assert that synthetic URL credentials are not printed.

Initial checks identified two typing mistakes (the Zod coercion input generic and use of a private test configuration property); both were corrected. The initial HTTP test assumed every unregistered URL uses Nest's JSON error format. Nest 12 delegates paths outside the global prefix to Express's default 404; the tests now assert the 404 status there and the built-in JSON shape inside `/api/v1`, preserving framework behavior.

## Changed files

- `src/config/environment.ts`, `src/app.module.ts`, `src/main.ts`: validated, typed startup configuration.
- `src/configure-application.ts`: shared HTTP prefix, validation pipe and Swagger setup.
- `src/greeting.schema.ts`, `src/app.controller.ts`, `src/app.service.ts`: documented strict request example and plain-text responses.
- `test/environment.spec.ts`, `test/startup.spec.ts`, `test/app.spec.ts`, `test/setup-env.ts`: isolated configuration and HTTP coverage.
- `jest.config.js`, `tsconfig.test.json`: deterministic test environment and compiled entry point for startup tests.
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`: three pinned runtime dependencies and disabled Scarf install telemetry.
- `.env.example`, `README.md`, `docs/pr-02-verification.md`: environment contract, usage and verification evidence.

## Review and remaining issues

Reviewed source, tests, documentation and lockfile changes for security, dependency additions and milestone scope. Direct additions are only `@nestjs/config@12.0.1`, `@nestjs/swagger@12.0.2` and `zod@4.6.6`, matching PR-00. Their optional class-validator/class-transformer peers remain absent. Swagger brings Scarf transitively; its install script is explicitly disabled alongside existing ignored scripts. The existing installation still emitted an ignored-Scarf-script notice. Jest emitted its existing experimental VM-modules warning. Neither warning blocked verification.

The ESM configuration, PR-00 spike, compatibility report, ADRs and original plans are unchanged. No database integration, authentication, authorization, Docker, CI, custom error filter or optional extension was added. No remaining PR-02 blocker was found. Database connectivity and later security milestones remain outside these checks.
