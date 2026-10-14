import { defineConfig, mergeConfig } from 'vitest/config';
import shared from './vitest.shared.js';

const globalThresholds = {
  statements: 90,
  branches: 85,
  functions: 90,
  lines: 90,
};
const featureThresholds = {
  statements: 95,
  branches: 90,
  functions: 90,
  lines: 95,
};

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
      exclude: ['test/e2e/**'],
      globalSetup: ['test/setup-subprocess.ts'],
      testTimeout: 120_000,
      hookTimeout: 120_000,
      coverage: {
        provider: 'v8',
        include: ['src/**/*.ts'],
        exclude: ['src/**/*.spec.ts'],
        reportsDirectory: 'coverage',
        reporter: ['text', 'html', 'lcov', 'json-summary'],
        thresholds: {
          ...globalThresholds,
          'src/modules/auth/**': featureThresholds,
          'src/modules/authorization/**': featureThresholds,
          'src/modules/users/**': featureThresholds,
          'src/modules/security/**': { ...featureThresholds, branches: 85 },
          // Vitest includes scoped files in the global aggregate. Preserve
          // Jest's additional floor on the remaining application as well.
          'src/{*.ts,!(modules)/**/*.ts,modules/!(auth|authorization|users|security)/**/*.ts}':
            globalThresholds,
        },
      },
    },
  }),
);
