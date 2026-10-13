# Docker and CI

## Local Compose setup

Use Docker Desktop or a Docker Engine installation with the Compose plugin and BuildKit. The host needs neither Node nor pnpm to run the application stack.

```sh
cp .env.example .env # First setup only; do not overwrite existing settings
# Review the local PostgreSQL values in .env
# Fill AUTH_SIGNING_KEY and AUTH_TRUSTED_ORIGINS (see authentication guide).
# Foreground mode; Ctrl-C stops the services cleanly:
docker compose up --build
```

The API is available at `http://localhost:3000/api/v1`. The default stack runs compiled production code; Swagger is disabled unless `SWAGGER_ENABLED=true` is set. Rebuild after changing source. For watch-mode development, use the existing `pnpm start:dev` workflow with your development database.

Compose starts PostgreSQL 17, waits for its `pg_isready` health check, then starts the API. The API's container health check uses `/api/v1/health/ready`: PostgreSQL must answer within one second. The fetch deadline is two seconds, within Docker's three-second command budget. `/api/v1/health/live` stays healthy during database outages; do not use readiness failure to trigger process restarts. See [health semantics and Kubernetes probes](health.md).

| Setting                    | Local Compose behavior                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`            | Database role, defaults to `app`                                                                              |
| `POSTGRES_DB`              | Database name, defaults to `app`                                                                              |
| `POSTGRES_PASSWORD`        | Required, with an illustrative development-only value in `.env.example`                                       |
| `API_PORT`                 | Host port, defaults to 3000, bound to `127.0.0.1`                                                             |
| `SWAGGER_ENABLED`          | Defaults to `false` in Compose                                                                                |
| `AUTH_SIGNING_KEY`         | Required random signing key; passed only to the API                                                           |
| `AUTH_TRUSTED_ORIGINS`     | Required exact HTTPS origins (Compose runs production mode)                                                   |
| `RATE_LIMIT_*`             | Optional; Compose defaults match the validated app defaults (100/60s global, 5/60s auth, 3/60s account)       |
| `TRUST_PROXY`              | Optional; defaults `false`. Set hop count or proxy IPs only behind a known proxy that alone can reach the API |
| `REQUEST_BODY_LIMIT_BYTES` | Optional; defaults to 16384 (16 KiB JSON/form cap, 413 beyond)                                                |

See [security](security.md) for rate-limit, proxy-trust and multi-instance details. Behind a TLS-terminating proxy, set `TRUST_PROXY` to that proxy and restrict network ingress so clients cannot reach the API directly.

The API and migration service construct an internal URL using the hostname `postgres`. Host-side `DATABASE_URL`, `PORT` and `NODE_ENV` from `.env` do not override the container URL, internal port 3000 or production mode. PostgreSQL is accessible only on the Compose network, not a published host port. Use `docker compose exec postgres psql -U app -d app` to inspect the default local database.

See [authentication setup](authentication.md#configuration-and-startup) for generating the signing key without printing it. Browser authentication requires a same-site HTTPS topology; Compose does not terminate TLS. Use a local HTTPS proxy or your browser's documented localhost Secure-cookie exception. Keep cookie flags secure. The standalone migration image requires only database configuration; Compose still interpolates required API values when parsing its complete project file.

Use URL-safe letters, digits, hyphens and underscores for this local Compose role/database/password, because those values are inserted into a connection URL. Production deployments should inject their own correctly URL-encoded `DATABASE_URL` through the platform's secret management. Compose is a local development example, not a production secret-management solution. Never commit `.env` or put credentials in Docker build arguments. Changing `POSTGRES_*` after volume initialization does not change existing database roles/passwords; manage those through PostgreSQL.

The named `postgres_data` volume survives restarts, container recreation and `docker compose down`. To stop the stack while keeping its data:

```sh
docker compose down
```

`docker compose down --volumes` deliberately deletes that project's local database. Do not use it on data you intend to keep.

## Explicit migrations

Startup never migrates the database. After the stack starts, run in another terminal:

```sh
docker compose run --build --rm migrate
```

The profiled `migrate` service is a one-off command and does not start during normal `docker compose up`. It uses the dedicated `migration` build target and the existing `pnpm db:migrate` command. It can also start/wait for PostgreSQL when invoked independently. Re-running it preserves previously applied migrations and existing rows.

Build standalone images for deployment from the same commit:

```sh
docker build --target runtime -t ultra-nest-template:local .
docker build --target migration -t ultra-nest-template-migrate:local .
```

Inject a production `DATABASE_URL` into a one-off migration container using your deployment platform, apply reviewed migrations once, then deploy the application image. The migration image includes Drizzle Kit and schema/migration files; it is a tooling image, not the long-running service. Supply migrations with an authorized identity and plan backups/forward fixes for data-changing releases. The runtime image intentionally has no migration CLI or migrations. No image publication or deployment is performed by CI.

## Image and shutdown behavior

All stages use `node:24.21.0-bookworm-slim`, matching `.nvmrc`. The tooling stage installs pnpm 10.33.0. Manifest/lockfile layers precede source layers, and dependency installation uses a BuildKit pnpm store cache. A separate production-only install omits optional packages; the explicitly required PostgreSQL driver remains installed.

The final image copies only `package.json`, production `node_modules` and compiled `dist`. The manifest retains `type: module` for ESM. `.dockerignore` uses an allowlist so local dependencies, `.env`, Git metadata, tests, docs and the compatibility spike stay outside the build context. Both application and migration targets run as the unprivileged `node` user. Local Compose also runs the API with a read-only filesystem, temporary `/tmp`, no Linux capabilities and no privilege escalation.

The exec-form `node dist/main.js` command receives SIGTERM directly, and the existing Nest shutdown hooks disable readiness, apply Terminus's five-second SIGTERM propagation window, drain HTTP requests, then let Drizzle close the pool. Compose supplies a small init process and a 30-second stop grace period. No package-manager or shell wrapper sits between Node and runtime shutdown signals. The smoke test accepts API exit 0 or 143 (normal SIGTERM), also exercises SIGINT (0 or 130), requires PostgreSQL exit 0 and rejects forced-kill behavior. Arbitrary stuck application handlers/hooks still need the supervisor's outer deadline; see [lifecycle limitations](health.md#shutdown-order-and-ownership).

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`, with a read-only repository token and immutable action commit pins. Ubuntu 24.04 hosted runners provide Docker; Testcontainers starts its own disposable PostgreSQL database, with resource cleanup enabled. No shared service database or repository secret is needed. pnpm's store is cached by the root lockfile.

The `Verify` job executes, in order:

1. `pnpm install --frozen-lockfile`
2. `pnpm lint`
3. `pnpm format:check`
4. `pnpm typecheck`
5. `pnpm test`
6. Docker availability check and `pnpm test:integration`
7. `pnpm build`
8. `bash scripts/verify-compose.sh`

The test suites run sequentially because both rebuild `.test-dist`. The Compose script builds the runtime and migration images, exercises HTTP validation and registration/login/rotation/logout against PostgreSQL, checks non-root execution/runtime contents, verifies no startup migration, applies explicit migrations twice, checks data survives PostgreSQL restart and container recreation, and checks clean shutdown. It also stops PostgreSQL, verifies the exact image HEALTHCHECK and Docker unhealthy status while liveness stays 200, restores readiness without restarting the API, and observes 503 during the SIGTERM drain window. It creates a unique project with an ephemeral host port and generated test credentials/signing key, then removes only its own containers and volume. It ignores the developer's `.env` and needs no repository secrets. Run it locally with Node and Docker on PATH to reproduce the container checks.

Dependabot checks the root npm/pnpm manifest/lockfile, GitHub Actions and Docker definitions weekly. Development minor/patch updates are grouped; updates are PRs requiring review and CI. No automatic merge is configured. The historical PR-00 spike is intentionally not an update target. Review Node changes together across `.nvmrc`, package engines, Dockerfile and the smoke test; pnpm remains pinned consistently in the manifest, image and workflow.

## Branch protection / required checks

After this workflow has produced a successful run, a repository administrator can configure **Settings → Branches → Add branch protection rule** for `main` (or the equivalent repository ruleset):

- Require pull requests and at least one approving review; optionally dismiss stale approvals.
- Require status checks before merging; select the GitHub Actions check named **Verify** from workflow **CI**, and require the branch to be up to date.
- Block force pushes and branch deletion. Apply the rule to administrators if that matches the team's policy.
- Keep dependency updates subject to the same review/check requirements; do not enable auto-merge as part of this baseline.

Do not select an unreported check name; GitHub must first see the workflow check. Private repository branch-protection availability depends on the account plan. These are setup instructions: this PR does not change repository protection, permissions or merge settings. See [GitHub branch protection documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

Successful local commands do not establish GitHub CI success. Check the PR's latest commit under **Checks → CI → Verify**; the PR report links the actual GitHub run once it completes.
