#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Never touch the developer's Compose project, .env, credentials or volume.
project="nest-smoke-$(date +%s)-$$"
export POSTGRES_USER=smoke POSTGRES_DB=smoke API_PORT=0 SWAGGER_ENABLED=false
POSTGRES_PASSWORD="$(node -e 'console.log(require("node:crypto").randomUUID())')"
export POSTGRES_PASSWORD
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
