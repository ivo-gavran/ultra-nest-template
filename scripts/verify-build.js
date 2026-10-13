import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import process from 'node:process';

// Run with --enable-source-maps after the production build. No server or DB.
const files = readdirSync('dist', { recursive: true }).map(String);
assert.ok(files.includes('main.js.map'));
for (const path of files) {
  assert.doesNotMatch(
    path,
    /(?:sql-privacy-probe|release-fixture|\.spec\.|\.test\.)/,
  );
  if (!path.endsWith('.js')) continue;
  const mapPath = join('dist', `${path}.map`);
  assert.ok(existsSync(mapPath), `Missing map for ${path}`);
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  assert.equal(map.version, 3);
  assert.equal(map.sourcesContent, undefined, 'Do not embed source contents');
  assert.equal(map.sourceRoot, '');
  assert.ok(map.sources.length > 0);
  for (const source of map.sources) {
    assert.equal(isAbsolute(source), false);
    assert.match(source, /^(?:\.\.\/)+src\/.*\.ts$/);
  }
}
// Exercise actual V8 remapping using an existing deterministic validation error.
const { PasswordsService } =
  await import('../dist/modules/users/passwords.service.js');
assert.throws(
  () => new PasswordsService(undefined).hash(''),
  (error) => {
    assert.match(
      error.stack,
      /src\/modules\/users\/passwords\.service\.ts:\d+:\d+/,
    );
    return true;
  },
);
process.stdout.write(
  `Verified ${files.filter((path) => path.endsWith('.js.map')).length} production maps and internal stack remapping.\n`,
);
