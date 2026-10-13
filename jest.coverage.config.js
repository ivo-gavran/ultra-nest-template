import config from './jest.config.js';

/** @type {import('jest').Config} */
export default {
  ...config,
  // One compilation and one sequential Jest run; unit + real-DB integration.
  // Dedicated E2E is a separate CI step with production defaults.
  testPathIgnorePatterns: ['/test/e2e/'],
  testTimeout: 120000,
  coverageProvider: 'v8',
  collectCoverageFrom: [
    '.test-dist/src/**/*.js',
    '!.test-dist/src/**/*.spec.js',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'html', 'lcov', 'json-summary'],
  // Baseline: ~98% lines / 94% branches. Leave headroom for meaningful
  // changes, while protecting each critical area independently of the rest.
  coverageThreshold: {
    global: { statements: 90, branches: 85, functions: 90, lines: 90 },
    './src/modules/auth/': {
      statements: 95,
      branches: 90,
      functions: 90,
      lines: 95,
    },
    './src/modules/authorization/': {
      statements: 95,
      branches: 90,
      functions: 90,
      lines: 95,
    },
    './src/modules/users/': {
      statements: 95,
      branches: 90,
      functions: 90,
      lines: 95,
    },
    './src/modules/security/': {
      statements: 95,
      branches: 85,
      functions: 90,
      lines: 95,
    },
  },
};
