import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import shared from './vitest.shared.js';

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
      exclude: ['test/integration/**', 'test/e2e/**'],
      globalSetup: ['test/setup-subprocess.ts'],
      // Subprocess imports are invisible to Vitest's in-memory module graph.
      forceRerunTriggers: [
        ...configDefaults.forceRerunTriggers,
        '**/src/**/*.ts',
        '**/test/fixtures/**/*.ts',
        '**/tsconfig.subprocess.json',
      ],
    },
  }),
);
