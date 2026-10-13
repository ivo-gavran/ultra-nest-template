#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Never touch the developer's Compose project, .env, credentials or volume.
project="nest-smoke-$(date +%s)-$$"
export POSTGRES_USER=smoke POSTGRES_DB=smoke API_PORT=0 SWAGGER_ENABLED=false
POSTGRES_PASSWORD="$(node -e 'console.log(require("node:crypto").randomUUID())')"
export POSTGRES_PASSWORD
AUTH_SIGNING_KEY="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
export AUTH_SIGNING_KEY AUTH_TRUSTED_ORIGINS=https://app.example.test
compose() { docker compose --env-file /dev/null --project-name "$project" "$@"; }
cleanup() { compose down --volumes --remove-orphans; }
trap cleanup EXIT
psql() {
  compose exec -T postgres sh -c 'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<< "$1"
}

compose up --build --detach --wait --wait-timeout 120
api_id="$(compose ps -q api)"
postgres_id="$(compose ps -q postgres)"
address="$(compose port api 3000)"

compose exec -T api node --input-type=module -e '
  import assert from "node:assert/strict";
  import { existsSync } from "node:fs";
  assert.notEqual(process.getuid(), 0);
  assert.equal(process.version, "v24.21.0");
  for (const path of ["src", "test", ".env", ".git", "migrations", "node_modules/jest", "node_modules/typescript", "node_modules/drizzle-kit"]) {
    assert.equal(existsSync(path), false, `Unexpected runtime file: ${path}`);
  }
'
API_URL="http://$address" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const base = process.env.API_URL;
const response = await fetch(`${base}/api/v1`);
assert.equal(response.status, 200);
assert.equal(await response.text(), 'Hello World!');
assert.equal((await fetch(`${base}/docs`)).status, 404);
const invalid = await fetch(`${base}/api/v1/greetings`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'smoke', extra: true }),
});
assert.equal(invalid.status, 400);
console.log('Container HTTP, validation, production docs and runtime checks passed.');
JS

test "$(psql "select to_regclass('public.example_records') is null;")" = t
compose run --build --rm migrate
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
const revoked = await fetch(`${base}/sessions/${current.id}`, { method: 'DELETE', headers });
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

# Restart and then recreate containers; both must retain the named volume.
compose restart postgres
compose up --detach --wait --wait-timeout 120
test "$(psql "select count(*) from example_records where label = 'persistence-smoke';")" = 1
compose up --detach --force-recreate --wait --wait-timeout 120
api_id="$(compose ps -q api)"
postgres_id="$(compose ps -q postgres)"
test "$(psql "select count(*) from example_records where label = 'persistence-smoke';")" = 1

compose stop
api_exit="$(docker inspect --format '{{.State.ExitCode}}' "$api_id")"
postgres_exit="$(docker inspect --format '{{.State.ExitCode}}' "$postgres_id")"
case "$api_exit" in 0|143) ;; *) echo "Unexpected API exit: $api_exit"; exit 1 ;; esac
test "$postgres_exit" = 0
test "$(docker inspect --format '{{.State.OOMKilled}}' "$api_id")" = false
echo "Explicit migrations, persisted data and clean shutdown passed (API=$api_exit, PostgreSQL=$postgres_exit)."
