import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

function buildSubprocesses() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  rmSync(new URL('../.test-process-dist/', import.meta.url), {
    recursive: true,
    force: true,
  });
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('../node_modules/typescript/bin/tsc', import.meta.url),
      ),
      '-p',
      'tsconfig.subprocess.json',
    ],
    { cwd: root, stdio: 'inherit' },
  );
}

export default function setup(project: TestProject) {
  buildSubprocesses();
  // Recompile on watch reruns so child processes never execute stale source.
  project.onTestsRerun(buildSubprocesses);
}
