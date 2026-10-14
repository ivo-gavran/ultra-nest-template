import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Nest DI requires SWC's legacy decorator metadata, not Vite's transform.
  oxc: false,
  plugins: [
    swc.vite({
      swcrc: false,
      sourceMaps: true,
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    environment: 'node',
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    clearMocks: true,
    restoreMocks: true,
    setupFiles: ['test/setup-env.ts'],
    sequence: { hooks: 'list' },
  },
});
