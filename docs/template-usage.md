# Using the GitHub template

## Create an independently named application

On the upstream repository, click **Use this template → Create a new repository**. Choose your owner/name and clone the generated repository, rather than the upstream template. Install the pinned Node 24.21.0 and pnpm 10.33.0 (see the root README), then run:

```sh
pnpm install --frozen-lockfile
pnpm setup:project my-awesome-api
pnpm hooks:install
cp .env.example .env # First setup only; never overwrite an existing environment
```

Configure the environment as described below, provision PostgreSQL, then:

```sh
pnpm db:migrate
pnpm start:dev
```

For Docker, follow [local Compose setup](docker-ci.md#local-compose-setup) instead; it provisions an isolated database and explicitly runs the migration image. Testcontainers integration/E2E suites need Docker, but do not use your development database. Run the checks listed in the README and commit the initialized files, including `.project-setup.json`, in your new repository.

Initialization uses [Node's native TypeScript support](https://nodejs.org/api/typescript.html), with no additional loader or CLI dependencies. It runs only when explicitly invoked: installation, builds and application startup never initialize or rename the project. Contributors maintaining Ultra Nest Template itself keep the original identity and skip this command.

## Names and repeat execution

Supply exactly one name. The initializer accepts a conservative subset of [unscoped npm package names](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#name): 1–63 lowercase ASCII letters, digits, dots, underscores or hyphens, starting and ending with a letter or digit. Consecutive dots, `node_modules`, `favicon.ico`, scopes, whitespace, separators and shell metacharacters are rejected. The 63-character cap also fits the existing telemetry service-name validation. A repository name outside these rules can still use a valid, independent package name.

Missing, extra or invalid arguments produce a usage message and a nonzero exit without modifying any file. The already-pinned Prettier formats the planned edits in memory, keeping table padding and long names consistent with existing checks. No dependency is added. All targeted files, expected identity values and formatting are checked before writes; missing, customized, ambiguous or symlinked targets are rejected without partial edits. Run initialization before customizing branding. Ordinary write errors trigger restoration of the original contents. A killed process, power loss or restoration failure can still require recovery from Git; run this local command serially in a clean checkout and inspect the diff before committing.

The deterministic `.project-setup.json` marker records only format version and project name, without timestamps, machine paths or secrets. Repeating the command with the same name is a no-op, preserving later edits and any custom telemetry settings. A different name is rejected. A marker/package disagreement or an already customized package without a marker is also rejected. Renaming an established application is a separate manual change; do not remove the marker to bypass these checks.

## Exact automatic edits

| File                                               | Change                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `package.json`                                     | npm package name only; version `1.0.0`, private status, scripts and dependencies retained |
| `README.md`                                        | Heading and introductory application identity; upstream provenance retained               |
| `src/configure-application.ts`                     | Swagger title becomes the package name; description becomes `<name> REST API`             |
| `src/config/telemetry.ts`                          | Default `OTEL_SERVICE_NAME`, used by logs/traces/metrics                                  |
| `src/modules/observability/open-telemetry.ts`      | Custom tracer and meter scope names become `<name>.http`                                  |
| `.env.example`                                     | Commented service-name example only                                                       |
| `compose.yaml`                                     | Fallback `OTEL_SERVICE_NAME` only                                                         |
| `scripts/verify-compose.sh`                        | Expected default service in the log assertion                                             |
| `test/app.spec.ts`                                 | Expected title/description in the real HTTP Swagger check                                 |
| `test/observability.spec.ts`                       | Expected default service                                                                  |
| `test/integration/observability.spec.ts`           | Test logger's default service                                                             |
| `test/integration/observability-bootstrap.spec.ts` | Expected HTTP instrumentation scopes                                                      |
| `docs/observability.md`                            | Default service and example log service                                                   |
| `docs/docker-ci.md`                                | Runtime/migration image tag examples                                                      |
| `docs/health.md`                                   | Application image example                                                                 |
| `.project-setup.json`                              | New initialization marker, to commit with the other edits                                 |

The current pnpm v9-format lockfile identifies the root importer as `.` and has no root package-name field. `pnpm-lock.yaml` stays byte-for-byte unchanged because dependencies are unchanged; `pnpm install --frozen-lockfile` remains valid after renaming.

Upstream GitHub URLs, v1.0.0 release history/attribution, contributor clone instructions, this guide's illustrative `my-awesome-api` name and initializer regression fixtures deliberately remain. Initialization does not rewrite the initializer itself. Upstream naming in those contexts is intentional, rather than stale active application configuration.

Formatting may adjust line wrapping or Markdown table padding in the edited files. No `.env`, signing key, PostgreSQL role/database/password, telemetry credential, API prefix, route, cookie, Origin/CSRF/CORS rule, rate budget, database schema or migration changes. Authentication, deny-by-default authorization, safe response projections, sanitized logs/traces, health probes, Docker hardening, CI, Dependabot, Lefthook and coverage thresholds are retained. `OTEL_SERVICE_NAME` remains overridable through validated configuration; the instrumentation scope is the initialized application name regardless of that override.

## Manual configuration and production preparation

- **Authentication:** generate a fresh random 32-byte signing key encoded as 64 hex characters for each application/environment. Use the [authentication guide's command](authentication.md#configuration-and-startup), which writes it directly into untracked `.env` without printing it. Initialization never generates a key. Do not reuse the template's test keys or another application's key.
- **Browser origins:** set `AUTH_TRUSTED_ORIGINS` to exact frontend origins, including schemes/ports, with no paths or wildcards; production requires HTTPS. Configure a same-site HTTPS browser/API topology and preserve Secure/HttpOnly refresh cookies and native CSRF/CORS behavior.
- **PostgreSQL:** replace illustrative local credentials, provision the role/database and set a correctly URL-encoded `DATABASE_URL`. For Compose, configure `POSTGRES_*` as documented; host-run URLs use a host-accessible database, while Compose uses its internal `postgres` hostname. Apply reviewed migrations explicitly before starting dependent code. Changing `.env` does not rotate credentials in an already initialized volume.
- **Telemetry:** leave it disabled until you configure your own Sentry project/DSN or OTLP endpoint and collector authentication headers. Keep credentials in untracked local configuration or production secret management, never in source, logs or image build arguments. Review the [observability privacy guarantees](observability.md).
- **Local isolation:** use distinct directories or a unique Compose `-p` / `COMPOSE_PROJECT_NAME`, plus distinct `API_PORT` values. Compose already scopes networks and persistent volumes; initialization adds no static resource names. See [multiple local applications](docker-ci.md#multiple-local-applications).
- **Production:** supply secrets through the deployment platform, use TLS and reviewed proxy trust, disable Swagger unless deliberately exposed, review shared rate limiting for multiple replicas, scrypt capacity, refresh/tombstone retention and backup/rollback procedures. Follow the [deployment checklist](release-readiness.md#production-deployment-and-rollback-checklist), adapting upstream release references to your application's own release process. Passing starter tests is not a deployment authorization.

A generated repository carries files, not a configured deployment. Review its Actions permissions/availability, required checks and branch protection, Dependabot access, environments, secrets, registries, deployment workflows and release process separately. Repository settings are not initialized by this script.

## Verification

`pnpm test` includes CLI regression tests on temporary copies of the actual starter, including invalid/missing names, repeat/conflict behavior, branding, whole-tree preservation, placeholders, preflight failure and symlink rejection. Those tests never initialize the working source repository. They also run inside generated applications by restoring only known template branding in their disposable fixture.

`pnpm verify:template` exercises `harbor-orders-api` in an isolated copy: frozen install before and after initialization, initialization twice, lint, formatting, types, unit + integration coverage, E2E, build, build verification and the complete Compose smoke (explicit migrations, startup, auth, telemetry privacy and persistence). When invoked from an already initialized application, it verifies that application’s existing identity rather than attempting to rename it. It needs Docker and package registry access, excludes local environments/dependencies/artifacts, and cleans its temporary directory even on check failure. CI runs this after all existing baseline gates; coverage thresholds and security checks are unchanged. Run the test suites sequentially.

## One-time upstream GitHub presentation

The repository owner must manually enable **Settings → General → Template repository**, following [GitHub's template instructions](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository). Until enabled, GitHub does not offer the template creation flow. This change does not enable the setting or modify any other repository settings.

Recommended metadata for the upstream repository:

- **Description:** Production-ready NestJS REST API starter with TypeScript, PostgreSQL, Drizzle ORM, secure authentication, Vitest, Docker and observability.
- **Topics:** `nestjs`, `typescript`, `starter-template`, `postgresql`, `drizzle-orm`, `vitest`, `docker`, `authentication`, `opentelemetry`.
- **Website/homepage:** leave empty unless a maintained documentation site exists; optionally point to the repository's README at `https://github.com/ivo-gavran/ultra-nest-template#readme`. Do not imply that a hosted application or documentation site exists.

Generated application owners should supply their own description, topics and homepage rather than retaining upstream template marketing.
