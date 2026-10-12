# PR-04 verification

Local verification completed on 2026-10-12 with Node **24.21.0**, pnpm **10.33.0**, Docker Engine **29.8.0** and Docker Compose **5.5.1**, on macOS arm64. Branch `feat/pr-04-docker-ci` starts from the fetched `origin/main` commit **d5d94b5**, after PR-03 was merged.

## Changes

- `Dockerfile`: cached dependency/build stages, a separate migration target, and a non-root production runtime containing only the application manifest, production dependencies and compiled ESM output. Node is pinned to 24.21.0 and tooling pnpm to 10.33.0. Exec-form startup, SIGTERM and a basic HTTP container health check preserve the existing shutdown hooks.
- `.dockerignore`: build-context allowlist excluding environment secrets, local/generated artifacts, Git metadata and unrelated project content.
- `compose.yaml`: API, PostgreSQL 17 with a named data volume and health check, and an explicitly invoked migration profile. The API waits for the database, binds only to loopback locally and runs with restricted filesystem/privileges. Migrations are never run on startup.
- `.github/workflows/ci.yml`: PR/main workflow with immutable action pins, read-only token, pnpm caching, sequential application/integration tests and Docker Compose build/smoke verification.
- `.github/dependabot.yml`: weekly npm/pnpm, GitHub Actions, Dockerfile and Compose updates, with no auto-merge.
- `scripts/verify-compose.sh`: isolated, reproducible Docker verification reused by local checks and CI, including cleanup of its own generated project and volume.
- `.env.example`, `README.md`, `docs/database.md`, `docs/docker-ci.md`: local settings, deployment/migration instructions, CI and branch protection guidance.

## Local results

| Command / check                     | Result                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`    | Exit 0; existing download store selected through `npm_config_store_dir`             |
| `pnpm lint`                         | Exit 0                                                                              |
| `pnpm format:check`                 | Exit 0                                                                              |
| `pnpm typecheck`                    | Exit 0                                                                              |
| `pnpm test`                         | Exit 0; **50 tests passed**, 3 suites, none skipped                                 |
| `pnpm test:integration`             | Exit 0; **9 tests passed** against real PostgreSQL via Testcontainers, none skipped |
| `pnpm build`                        | Exit 0                                                                              |
| `bash -n scripts/verify-compose.sh` | Exit 0                                                                              |
| `bash scripts/verify-compose.sh`    | Exit 0; full container verification below                                           |
| `git diff --check`                  | Exit 0                                                                              |

The Compose script executed `docker compose up --build --detach --wait` in a unique project using generated test credentials and an ephemeral loopback port. Both image targets were built successfully. The build context was approximately 265 kB, excluding local dependencies and secrets.

Executed assertions:

- Runtime runs as non-root on Node 24.21.0; source, tests, `.env`, `.git`, migrations and development tools (Jest, TypeScript, Drizzle Kit) are absent from the runtime's application directory.
- Host HTTP request to `/api/v1`: 200 and `Hello World!`; unknown request field: 400; `/docs` in production mode: 404.
- Example table is absent before the explicit migration command, proving startup does not apply it.
- `docker compose run --build --rm migrate` succeeds on the empty database; a second run succeeds with an existing row and exactly one migration journal entry.
- The inserted row survives PostgreSQL restart and forced recreation of both containers with the same named volume.
- `docker compose stop` finishes without forced killing: API exit **143** (normal SIGTERM), PostgreSQL exit **0**, no API OOM kill.
- Temporary containers, network and test volume are removed by the script. No developer Compose project or database is modified.

## GitHub CI evidence

Local results above are not a claim of GitHub success. The PR's **CI / Verify** check records the hosted Ubuntu run and its exact commit. The final PR report links that run and reports its actual conclusion after GitHub completes it. Branch protection instructions use the reported **Verify** check; no repository settings are changed by this PR.

## Review and limitations

Reviewed source/configuration/docs and the complete diff for secrets, unnecessary dependencies, destructive migration behavior and scope violations. Application code, package manifests/lockfile, SQL migrations, architecture records and previous verification reports remain unchanged. No authentication, users, authorization, observability or optional services were added. Docker cleanup deletes only the smoke script's unique disposable volume.

The Compose configuration is local tooling: example credentials are explicitly development-only; production credentials must be injected externally. The existing HTTP route is a container liveness probe, not database readiness. The migration target is intentionally a separate development-tooling image. No image is published and no production deployment occurs. Dependabot activates after its configuration reaches the default branch; update PRs require normal review. Private repository branch protection also depends on the GitHub plan and administrator setup.

Existing non-blocking notices remain: Jest experimental VM modules and pnpm's ignored dependency install scripts. Local Docker verification covers Linux arm64 through Docker Desktop; the hosted CI run verifies Linux amd64. No broader platform claim is made.
