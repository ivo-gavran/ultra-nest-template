# PR-01 verification

Verified on 2026-10-12, macOS arm64, Node **24.21.0 LTS**, pnpm **10.33.0**. Branch: `feat/pr-01-bootstrap`; target: `main`.

## Changes

| Files                                                                             | Purpose                                                                                                        |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`, `src/app.module.ts`, `src/app.controller.ts`, `src/app.service.ts` | Minimal NestJS 12.1.3 application and public bootstrap route                                                   |
| `package.json`, `pnpm-lock.yaml`, `.npmrc`, `pnpm-workspace.yaml`, `.nvmrc`       | Exact dependency/runtime pins, reproducible installation and dependency-script policy; independent PR-00 spike |
| `tsconfig.json`, `tsconfig.build.json`, `tsconfig.test.json`, `nest-cli.json`     | Strict TypeScript 6.0.3, ESM and separate production/test output                                               |
| `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`        | Type-aware ESLint, formatting and editor conventions                                                           |
| `lefthook.yml`, `commitlint.config.js`                                            | Staged-path lint/format checks and Conventional Commits                                                        |
| `jest.config.js`, `test/app.spec.ts`                                              | Real Nest module/HTTP bootstrap tests using Jest over compiled ESM                                             |
| `.gitignore`, `.env.example`, `README.md`, this report                            | Output exclusions, current environment scope, onboarding and verification instructions                         |

Existing `AGENTS.md`, kickoff prompt, implementation plan, PR-00 report, both ADRs and every spike file remain unchanged. Root runtime dependencies are limited to Nest common/core/Express, reflect-metadata and RxJS. No auth, configuration/validation, Swagger, database, Docker, CI or optional-extension implementation was added.

## Results

The full checks ran in the working checkout and in a fresh temporary copy made from tracked/untracked project files, excluding ignored artifacts. The clean copy had no `node_modules`, `dist` or `.test-dist`. It used the existing pnpm download store through an environment setting, but installed and linked all dependencies afresh.

| Command / check                                          | Exact result                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `node --version` / `pnpm --version`                      | `v24.21.0` / `10.33.0`                                                          |
| `pnpm install --frozen-lockfile`                         | Exit 0 in the clean copy; lockfile unchanged, strict peer checks passed         |
| `pnpm hooks:install`                                     | Exit 0; installed `pre-commit` and `commit-msg`                                 |
| `pnpm lint`                                              | Exit 0, no warnings/errors                                                      |
| `pnpm format` / `pnpm format:check`                      | Exit 0; new files formatted, historical files preserved                         |
| `pnpm typecheck`                                         | Exit 0                                                                          |
| `pnpm test`                                              | Exit 0; **1 Jest suite, 2 tests passed**, 0 snapshots                           |
| `pnpm build`                                             | Exit 0; ESM and source maps in `dist`, no test output in production build       |
| `pnpm start:dev`                                         | Started via Nest watch mode; real `GET /` returned **200**, body `Hello World!` |
| `NODE_ENV=production pnpm start`                         | Real `GET /` returned **200**, body `Hello World!`                              |
| PR-00 frozen install, typecheck and test on Node 24.21.0 | Exit 0; **6 tests passed, 0 failed, 0 skipped**                                 |

Both server smoke checks used isolated ephemeral ports and terminated their process groups after receiving the response. This verifies startup, not a load test or production deployment. HTTP checks required permission to bind loopback sockets in this environment.

PR-00 was checked from its own directory using:

```sh
pnpm install --frozen-lockfile --ignore-scripts --ignore-workspace
pnpm --ignore-workspace typecheck
pnpm --ignore-workspace test
```

## Hook verification

Tests used installed hooks in the clean temporary Git repository, without creating test commits in the feature branch:

- `.git/hooks/commit-msg <message-file>` with `invalid message`: **exit 1**.
- Same hook with `feat: bootstrap application`: **exit 0**.
- `.git/hooks/pre-commit` with a staged unused-variable JS fixture: **exit 1**, ESLint `no-unused-vars` reported.
- Same hook with a staged unformatted JSON fixture: **exit 1**, Prettier rejected that file.
- Same hook with the clean project staged: **exit 0**.
- Actual `git commit -m 'invalid message'` in the temporary repository: **exit 1**; verified no `HEAD` commit was created.

Hooks run checks on the working copies of staged paths. They do not mutate or restage files and do not run the full build/test suite. Developers must explicitly install them per clone, as documented in README.

## Review and limitations

Reviewed the source/tooling diff and direct dependency list for scope, accidental generated output, secrets and unnecessary runtime packages. Existing historical files were compared with the base commit. The only environment example remains a local development placeholder.

No blocking PR-01 issue remains. Jest's native ESM execution prints Node's expected experimental VM Modules warning. Initial dependency resolution also reported deprecated transitive `glob@10.5.0`; no direct dependency override was introduced. No CI result is claimed: CI belongs to PR-04. PostgreSQL and auth checks remain their later milestones.

Node's official [download page](https://nodejs.org/en/download) identified 24.21.0 as LTS; the downloaded test runtime was checked against its published SHA-256. [Jest's ESM instructions](https://jestjs.io/docs/ecmascript-modules) informed the disabled transforms and VM Modules flag. Nest CLI's installed TypeScript loader resolves the project's pinned compiler; no unverified TypeScript 7 toolchain is used.
