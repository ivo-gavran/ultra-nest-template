import { defineConfig, mergeConfig } from 'vitest/config';
import shared from './vitest.shared.js';

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ['test/integration/**/*.spec.ts'],
      globalSetup: ['test/setup-subprocess.ts'],
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  }),
);
