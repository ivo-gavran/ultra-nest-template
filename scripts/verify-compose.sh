#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Never touch the developer's Compose project, .env, credentials or volume.
project="nest-smoke-$(date +%s)-$$"
export POSTGRES_USER=smoke POSTGRES_DB=smoke API_PORT=0 SWAGGER_ENABLED=false
# Smoke flows make many sequential auth calls from one client; production
# defaults (5/60s auth) would throttle them. Raise limits for smoke only.
# Ignore inherited telemetry settings; optional telemetry is exercised explicitly below.
unset SENTRY_DSN OTEL_ENABLED OTEL_EXPORTER_OTLP_ENDPOINT OTEL_EXPORTER_OTLP_HEADERS OTEL_SERVICE_NAME OTEL_EXPORTER_OTLP_TIMEOUT OTEL_TRACES_SAMPLER_ARG OTEL_METRIC_EXPORT_INTERVAL
unset TRUST_PROXY REQUEST_BODY_LIMIT_BYTES RATE_LIMIT_GLOBAL_TTL_MS RATE_LIMIT_AUTH_TTL_MS RATE_LIMIT_AUTH_BLOCK_MS RATE_LIMIT_ACCOUNT_TTL_MS
export RATE_LIMIT_AUTH_LIMIT=1000 RATE_LIMIT_GLOBAL_LIMIT=10000 RATE_LIMIT_ACCOUNT_LIMIT=1000
POSTGRES_PASSWORD="$(node -e 'console.log(require("node:crypto").randomUUID())')"
export POSTGRES_PASSWORD
AUTH_SIGNING_KEY="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
export AUTH_SIGNING_KEY AUTH_TRUSTED_ORIGINS=https://app.example.test
compose() { docker compose --env-file /dev/null --project-name "$project" "$@"; }
otlp="$project-otlp" otel_api="$project-otel-api" dead_api="$project-dead-otlp-api"
cleanup() {
  docker rm --force "$otlp" "$otel_api" "$dead_api" > /dev/null 2>&1 || true
  compose down --volumes --remove-orphans
}
trap cleanup EXIT
psql() {
  compose exec -T postgres sh -c 'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<< "$1"
}

compose up --build --detach --wait --wait-timeout 120
api_id="$(compose ps -q api)"
api_started_at="$(docker inspect --format '{{.State.StartedAt}}' "$api_id")"
postgres_id="$(compose ps -q postgres)"
address="$(compose port api 3000)"

compose exec -T api node --input-type=module -e '
  import assert from "node:assert/strict";
  import { existsSync, readdirSync, readFileSync } from "node:fs";
  assert.notEqual(process.getuid(), 0);
  assert.equal(process.version, "v24.21.0");
  for (const path of ["src", "test", ".env", ".git", "migrations", "node_modules/jest", "node_modules/typescript", "node_modules/drizzle-kit"]) {
    assert.equal(existsSync(path), false, `Unexpected runtime file: ${path}`);
  }
  for (const entry of readdirSync("node_modules/.pnpm")) {
    assert.doesNotMatch(entry, /^(jest|typescript|drizzle-kit|esbuild|sprintf-js|@nestjs\+cli|@testcontainers\+postgresql)@/);
  }
  const artifacts = readdirSync("dist", { recursive: true }).map(String);
  assert.ok(artifacts.includes("main.js.map"));
  assert.ok(!artifacts.some(path => /sql-privacy-probe|release-fixture|\.spec\./.test(path)));
  for (const path of artifacts.filter(path => path.endsWith(".map"))) {
    const map = JSON.parse(readFileSync(`dist/${path}`, "utf8"));
    assert.equal(map.sourcesContent, undefined);
    assert.ok(map.sources.every(source => /^(?:\.\.\/)+src\//.test(source)));
  }
  for (const path of artifacts.filter(path => /\.(js|map)$/.test(path))) {
    const text = readFileSync(`dist/${path}`, "utf8");
    for (const secret of [process.env.AUTH_SIGNING_KEY, new URL(process.env.DATABASE_URL).password])
      assert.equal(text.includes(secret), false, "Runtime secret baked into artifact");
  }
'
API_URL="http://$address" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const base = process.env.API_URL;
const response = await fetch(`${base}/api/v1`);
assert.equal(response.status, 200);
assert.equal(await response.text(), 'Hello World!');
for (const path of ["/docs", "/docs-json", "/dist/main.js.map", "/api/v1/observability-sql-probe"])
  assert.equal((await fetch(`${base}${path}`)).status, 404);
for (const probe of ['live', 'ready']) {
  const health = await fetch(`${base}/api/v1/health/${probe}`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('x-ratelimit-limit-global'), null);
}

const invalid = await fetch(`${base}/api/v1/greetings`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'smoke', extra: true }),
});
assert.equal(invalid.status, 400);
console.log('Container HTTP, validation, production docs and runtime checks passed.');
JS

test "$(psql "select to_regclass('public.example_records') is null;")" = t
compose run --build --rm migrate
compose run --rm --no-deps migrate node -e 'require("node:assert/strict").notEqual(process.getuid(), 0)'
psql "insert into example_records (label) values ('persistence-smoke');"
compose run --rm migrate
expected_migrations="$(node -e 'console.log(require("./migrations/meta/_journal.json").entries.length)')"
test "$(psql 'select count(*) from drizzle.__drizzle_migrations;')" = "$expected_migrations"

API_URL="http://$address" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const base = `${process.env.API_URL}/api/v1/auth`;
const input = { email: 'container-smoke@example.test', password: 'container smoke password' };
const post = (path, body = {}, cookie = '') => fetch(`${base}/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: process.env.AUTH_TRUSTED_ORIGINS, Cookie: cookie },
  body: JSON.stringify(body),
});
const created = await post('register', input);
assert.equal(created.status, 201);
assert.deepEqual(Object.keys(await created.json()).sort(), ['accessToken', 'expiresIn']);
assert.equal((await post('login', input)).status, 200);
const first = created.headers.get('set-cookie').split(';')[0];
const rotated = await post('refresh', {}, first);
assert.equal(rotated.status, 200);
const next = rotated.headers.get('set-cookie').split(';')[0];
assert.equal((await post('logout', {}, next)).status, 204);
assert.equal((await post('refresh', {}, next)).status, 401);
const login = await post('login', input);
const { accessToken } = await login.json();
const headers = { Authorization: `Bearer ${accessToken}`, Origin: process.env.AUTH_TRUSTED_ORIGINS };
const listing = await fetch(`${base}/sessions?limit=2`, { headers });
assert.equal(listing.status, 200);
assert.equal(listing.headers.get('cache-control'), 'no-store');
const { items } = await listing.json();
const current = items.find(item => item.current);
assert.ok(current);
assert.equal(current.status, 'active');
const revoked = await fetch(`${base}/sessions/${current.id}`, { method: 'DELETE', headers: { ...headers, Cookie: login.headers.get('set-cookie').split(';')[0] } });
assert.equal(revoked.status, 204);
assert.match(revoked.headers.get('set-cookie'), /HttpOnly/);
assert.match(revoked.headers.get('set-cookie'), /Secure/);
assert.equal((await post('refresh', {}, login.headers.get('set-cookie').split(';')[0])).status, 401);
const all = await fetch(`${base}/logout-all`, { method: 'POST', headers });
assert.equal(all.status, 204);
const final = await (await fetch(`${base}/sessions`, { headers })).json();
assert.ok(final.items.every(item => item.status === 'revoked'));
console.log('Production container auth, session listing, targeted revoke and logout-all passed.');
JS

API_URL="http://$address" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const base = `${process.env.API_URL}/api/v1`;
const input = { email: 'users-smoke@example.test', password: 'users smoke original password' };
const origin = process.env.AUTH_TRUSTED_ORIGINS;
const request = (path, method = 'GET', access = '', body, cookie = '') => fetch(`${base}/${path}`, {
  method,
  headers: { Origin: origin, ...(access ? { Authorization: `Bearer ${access}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), Cookie: cookie },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const first = await request('auth/register', 'POST', '', input);
assert.equal(first.status, 201);
const { accessToken } = await first.json();
const currentCookie = first.headers.get('set-cookie').split(';')[0];
const second = await request('auth/login', 'POST', '', input);
assert.equal(second.status, 200);
const otherCookie = second.headers.get('set-cookie').split(';')[0];
const profile = await request('users/me', 'GET', accessToken);
assert.equal(profile.status, 200);
assert.equal(profile.headers.get('cache-control'), 'no-store');
assert.deepEqual(Object.keys(await profile.json()).sort(), ['createdAt', 'displayName', 'email', 'id', 'role', 'updatedAt']);
assert.equal((await request('users/me')).status, 401);
assert.equal((await request('users', 'GET', accessToken)).status, 403);
assert.equal((await request('users/me', 'PATCH', accessToken, { role: 'admin' })).status, 400);
assert.equal((await request('users/me', 'PATCH', accessToken, { displayName: 'Container profile' })).status, 200);
const newPassword = 'users smoke replacement password';
const changed = await request('users/me/password', 'PATCH', accessToken, { currentPassword: input.password, newPassword }, currentCookie);
assert.equal(changed.status, 204);
assert.equal(changed.headers.get('set-cookie'), null);
assert.equal((await request('auth/login', 'POST', '', input)).status, 401);
assert.equal((await request('auth/login', 'POST', '', { ...input, password: newPassword })).status, 200);
assert.equal((await request('auth/refresh', 'POST', '', {}, otherCookie)).status, 401);
const rotated = await request('auth/refresh', 'POST', '', {}, currentCookie);
assert.equal(rotated.status, 200);
const nextCookie = rotated.headers.get('set-cookie').split(';')[0];
const deleted = await request('users/me', 'DELETE', accessToken, {}, nextCookie);
assert.equal(deleted.status, 204);
for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(deleted.headers.get('set-cookie').includes(flag));
assert.equal((await request('users/me', 'GET', accessToken)).status, 401);
assert.equal((await request('auth/refresh', 'POST', '', {}, nextCookie)).status, 401);
console.log('Production container users, password change, session revocation and account deletion passed.');
JS

API_URL="http://$address" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const base = process.env.API_URL;
// Security hardening smoke: rate-limit headers, 413 body cap, spoof resistance.
const root = await fetch(`${base}/api/v1`);
assert.equal(root.status, 200);
assert.equal(root.headers.get('x-ratelimit-limit-global'), '10000');
assert.equal(root.headers.get('x-content-type-options'), 'nosniff');
const big = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: process.env.AUTH_TRUSTED_ORIGINS },
  body: JSON.stringify({ email: 'big@example.test', password: 'x'.repeat(20000) }),
});
assert.equal(big.status, 413);
console.log('Production container rate-limit headers and body cap passed.');
JS
test "$(psql "select count(*) from users where email = 'users-smoke@example.test';")" = 0
test "$(psql 'select count(*) > 0 from auth_revoked_families r left join auth_token_families f using (family_id) where f.family_id is null;')" = t

# PR-12: telemetry is disabled by default; logs are JSON, correlated and
# carry no credentials, tokens, emails or raw identifiers.
API_URL="http://$address" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const response = await fetch(`${process.env.API_URL}/api/v1`, { headers: { 'X-Request-ID': 'smoke-correlation-0001' } });
assert.equal(response.headers.get('x-request-id'), 'smoke-correlation-0001');
const generated = await fetch(`${process.env.API_URL}/api/v1`, { headers: { 'X-Request-ID': 'bad id' } });
assert.match(generated.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
JS
compose logs --no-color --no-log-prefix api | node --input-type=module -e '
  import assert from "node:assert/strict";
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const records = input.trim().split("\n").map((line) => JSON.parse(line));
  for (const leaked of [
    process.env.POSTGRES_PASSWORD, process.env.AUTH_SIGNING_KEY, "smoke password", "original password",
    "replacement password", "@example.test", "Bearer ", "__Host-refresh", "eyJ",
  ]) assert.equal(input.includes(leaked), false, "Sensitive value found in logs");
  const completed = records.filter((record) => record.message === "http.request.completed");
  assert.ok(completed.length > 20);
  assert.ok(completed.every((record) => record.service === "ultra-nest-template" && record.requestId && !("traceId" in record)));
  assert.ok(completed.some((record) => record.requestId === "smoke-correlation-0001"));
  assert.ok(completed.some((record) => record.route === "/api/v1/auth/sessions/:id"));
  assert.equal(completed.some((record) => String(record.route).includes("health")), false);
  const { requestId: _r, ...rest } = completed.find((record) => record.route === "/api/v1/auth/sessions/:id");
  assert.doesNotMatch(JSON.stringify(rest), /[0-9a-f]{8}-[0-9a-f]{4}-/);
  console.log(`Disabled-telemetry JSON logs passed (${records.length} records, no secrets).`);
'

# An API from the same image exporting OTLP/HTTP to a local receiver on the
# Compose network, then one whose collector is unreachable.
image="$(docker inspect --format '{{.Config.Image}}' "$api_id")"
network="${project}_default"
docker run --detach --name "$otlp" --network "$network" node:24.21.0-bookworm-slim node -e '
  require("node:http").createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk)).on("end", () => {
      console.log(JSON.stringify({ path: request.url, authorization: request.headers.authorization ?? null, body }));
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  }).listen(4318);
' > /dev/null
run_api() {
  local name="$1"; shift
  docker run --detach --name "$name" --network "$network" --publish 127.0.0.1::3000 \
    --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --init \
    --env DATABASE_URL="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB" \
    --env AUTH_SIGNING_KEY --env AUTH_TRUSTED_ORIGINS --env RATE_LIMIT_AUTH_LIMIT \
    "$@" "$image" > /dev/null
}
wait_ready() {
  API_URL="http://$(docker port "$1" 3000)" node --input-type=module <<'JS'
import { setTimeout } from 'node:timers/promises';
const deadline = Date.now() + 60000;
for (;;) {
  const response = await fetch(`${process.env.API_URL}/api/v1/health/ready`).catch(() => undefined);
  if (response?.status === 200) break;
  if (Date.now() > deadline) throw new Error('Telemetry API did not become ready');
  await setTimeout(250);
}
JS
}
stop_api() {
  local started=$SECONDS
  docker stop --time 30 "$1" > /dev/null
  local code; code="$(docker inspect --format '{{.State.ExitCode}}' "$1")"
  case "$code" in 0|143) ;; *) echo "Unexpected $1 exit: $code"; docker logs "$1"; exit 1 ;; esac
  test $((SECONDS - started)) -lt 25
}
run_api "$otel_api" --env OTEL_ENABLED=true --env OTEL_SERVICE_NAME=smoke-otel \
  --env OTEL_EXPORTER_OTLP_ENDPOINT="http://$otlp:4318" --env OTEL_TRACES_SAMPLER_ARG=1 \
  --env OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20smoke-collector-token
wait_ready "$otel_api"
API_URL="http://$(docker port "$otel_api" 3000)" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const base = `${process.env.API_URL}/api/v1`;
const registered = await fetch(`${base}/auth/register`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json', Origin: process.env.AUTH_TRUSTED_ORIGINS,
    traceparent: '00-5b8efff798038103d269b633813fc60c-eee19b7ec3c1b174-01',
  },
  body: JSON.stringify({ email: 'otel-smoke@example.test', password: 'otel smoke password phrase' }),
});
assert.equal(registered.status, 201);
const { accessToken } = await registered.json();
assert.equal((await fetch(`${base}/users/me`, { headers: { Authorization: `Bearer ${accessToken}` } })).status, 200);
JS
stop_api "$otel_api"
docker logs "$otlp" | node --input-type=module -e '
  import assert from "node:assert/strict";
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const requests = input.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(requests.every((request) => request.authorization === "Bearer smoke-collector-token"));
  const spans = requests.filter((request) => request.path === "/v1/traces").flatMap((request) =>
    JSON.parse(request.body).resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) =>
      scope.spans.map((span) => ({ ...span, scope: scope.scope.name })))));
  const register = spans.find((span) => span.name === "POST /api/v1/auth/register");
  assert.equal(register?.traceId, "5b8efff798038103d269b633813fc60c");
  assert.equal(register.parentSpanId, "eee19b7ec3c1b174");
  const pg = spans.filter((span) => span.scope === "@opentelemetry/instrumentation-pg");
  assert.ok(pg.some((span) => span.parentSpanId === register.spanId), "pg spans must be children of the server span");
  assert.ok(requests.some((request) => request.path === "/v1/metrics" && request.body.includes("http.server.request.duration")));
  const bodies = requests.map((request) => request.body).join("\n");
  for (const leaked of [process.env.POSTGRES_PASSWORD, process.env.AUTH_SIGNING_KEY, "otel-smoke@example.test", "otel smoke password", "eyJ", "smoke-collector-token", "drizzle."])
    assert.equal(bodies.includes(leaked), false, "Sensitive value found in telemetry");
  console.log(`Production image OTLP export passed (${spans.length} spans, ${pg.length} PostgreSQL).`);
'
otel_logs="$(docker logs "$otel_api" 2>&1)"
grep -q '"traceId":"5b8efff798038103d269b633813fc60c"' <<< "$otel_logs"
if grep -q 'smoke-collector-token' <<< "$otel_logs"; then echo 'Collector header leaked to logs'; exit 1; fi

run_api "$dead_api" --env OBSERVABILITY_SQL_PROBE=1 --env OTEL_ENABLED=true --env OTEL_EXPORTER_OTLP_TIMEOUT=2000 \
  --env OTEL_EXPORTER_OTLP_ENDPOINT="http://$project-no-collector:4318" --env OTEL_TRACES_SAMPLER_ARG=1
wait_ready "$dead_api"
API_URL="http://$(docker port "$dead_api" 3000)" node --input-type=module -e '
  import assert from "node:assert/strict";
  for (let i = 0; i < 5; i++) assert.equal((await fetch(`${process.env.API_URL}/api/v1`)).status, 200);
  assert.equal((await fetch(`${process.env.API_URL}/api/v1/observability-sql-probe`)).status, 404);
'
stop_api "$dead_api"
echo 'Unreachable collector did not affect requests and shutdown stayed bounded.'
docker rm --force "$otlp" "$otel_api" "$dead_api" > /dev/null

# Exercise the exact image HEALTHCHECK command, including a real outage.
healthcheck() {
  compose exec -T api sh -c "$(docker inspect --format '{{index .Config.Healthcheck.Test 1}}' "$api_id")"
}
healthcheck
compose stop postgres
if healthcheck; then echo 'Readiness HEALTHCHECK incorrectly passed with PostgreSQL stopped'; exit 1; fi
API_URL="http://$address" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const base = `${process.env.API_URL}/api/v1/health`;
for (let i = 0; i < 5; i++) {
  assert.equal((await fetch(`${base}/live`)).status, 200);
  const ready = await fetch(`${base}/ready`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), {
    status: 'error', info: {}, error: { postgres: { status: 'down' } }, details: { postgres: { status: 'down' } },
  });
}
JS
# Poll Docker's own recorded health state, bounded by its 10s interval / 3 retries.
wait_for_health() {
API_ID="$api_id" EXPECTED_HEALTH="$1" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
let status;
const deadline = Date.now() + 60000;
do {
  status = execFileSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', process.env.API_ID], { encoding: 'utf8' }).trim();
  if (status === process.env.EXPECTED_HEALTH) break;
  await setTimeout(250);
} while (Date.now() < deadline);
assert.equal(status, process.env.EXPECTED_HEALTH);
assert.equal(execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', process.env.API_ID], { encoding: 'utf8' }).trim(), 'true');
JS
}
wait_for_health unhealthy
compose start postgres
# Compose --wait rejects an already-unhealthy container immediately. Wait for
# Docker to record the next successful probe before asserting the stack.
wait_for_health healthy
# Do not reconcile the stack with `up` here: some Compose versions recreate
# containers after the migration image build, invalidating this recovery test.
test "$(compose ps -q api)" = "$api_id"
test "$(docker inspect --format '{{.State.StartedAt}}' "$api_id")" = "$api_started_at"
healthcheck
echo 'Readiness HEALTHCHECK fails on outage and recovers; liveness stays healthy without an API restart.'

# Restart and then recreate containers; both must retain the named volume.
compose restart postgres
compose up --detach --no-recreate --wait --wait-timeout 120
test "$(psql "select count(*) from example_records where label = 'persistence-smoke';")" = 1

test "$(psql "select count(*) from users where email = 'users-smoke@example.test';")" = 0
test "$(psql 'select count(*) > 0 from auth_revoked_families r left join auth_token_families f using (family_id) where f.family_id is null;')" = t
compose up --detach --force-recreate --wait --wait-timeout 120
api_id="$(compose ps -q api)"
postgres_id="$(compose ps -q postgres)"
test "$(psql "select count(*) from example_records where label = 'persistence-smoke';")" = 1

# SIGINT takes the existing Nest shutdown path without the SIGTERM drain delay.
docker kill --signal SIGINT "$api_id" > /dev/null
API_ID="$api_id" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const code = execFileSync('docker', ['wait', process.env.API_ID], { encoding: 'utf8', timeout: 30000 }).trim();
assert.ok(['0', '130'].includes(code), `Unexpected SIGINT exit: ${code}`);
JS
compose up --detach --no-recreate --wait --wait-timeout 120
address="$(compose port api 3000)"

# The normal Compose stop path sends SIGTERM and retains its 30s outer limit.
# Terminus's 5s delay makes readiness observable while Node still serves HTTP.
COMPOSE_PROJECT="$project" API_URL="http://$address" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
const stop = promisify(execFile)('docker', ['compose', '--env-file', '/dev/null', '--project-name', process.env.COMPOSE_PROJECT, 'stop', 'api'], { timeout: 35000 });
const base = `${process.env.API_URL}/api/v1/health`;
let draining = false;
const deadline = Date.now() + 4000;
try {
  do {
    const response = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(1500) });
    if (response.status === 503) {
      draining = true;
      assert.equal((await fetch(`${base}/live`)).status, 200);
      break;
    }
    await setTimeout(50);
  } while (Date.now() < deadline);
  assert.equal(draining, true, 'Readiness must fail during the SIGTERM drain window');
} finally { await stop; }
JS
compose stop postgres
api_exit="$(docker inspect --format '{{.State.ExitCode}}' "$api_id")"
postgres_exit="$(docker inspect --format '{{.State.ExitCode}}' "$postgres_id")"
case "$api_exit" in 0|143) ;; *) echo "Unexpected API exit: $api_exit"; exit 1 ;; esac
test "$postgres_exit" = 0
test "$(docker inspect --format '{{.State.OOMKilled}}' "$api_id")" = false
echo "Explicit migrations, persisted data and clean shutdown passed (API=$api_exit, PostgreSQL=$postgres_exit)."
