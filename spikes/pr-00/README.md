# PR-00 compatibility probe

This standalone package is a disposable API/compatibility probe, not the application scaffold. Root planning documents were copied unchanged from the supplied files. PR-01 has not started.

Use Node 24 and pnpm 10.33.0:

```sh
cd spikes/pr-00
node --version
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm exec drizzle-kit --version
```

`pnpm test` builds first and runs six Node test-runner cases. One temporarily listens on an ephemeral loopback port; all apps/pools are closed. A sandbox that forbids sockets requires permission for this test. No running database or secrets are needed. Dependencies are pinned, peer checks are strict and optional peers are not auto-installed. Dependency lifecycle scripts are disabled for the spike.

The tests use Nest's test-mode in-memory authentication defaults and synthetic users. The Drizzle probe compiles SQL without sending it to a server. The official storage contract harness is imported and inspected, not executed against PostgreSQL. Never transplant these fixtures as production stores/controllers. Jest/Supertest/Testcontainers configuration remains in the planned application milestones; using Node's runner here keeps PR-00 independent.

See the [compatibility report](../../docs/pr-00-compatibility.md), [transport ADR](../../docs/adr/001-auth-transport.md), and [session-model ADR](../../docs/adr/002-auth-session-model.md) for results, scope limits and follow-up gates.
