import { defineConfig } from 'vitest/config';
import shared from './vitest.shared.js';

export default defineConfig({
  ...shared,
  test: {
    ...shared.test,
    include: ['test/e2e/**/*.spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    setupFiles: ['test/e2e/setup.ts'],
  },
});
