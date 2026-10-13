import config from './jest.config.js';

/** @type {import('jest').Config} */
export default {
  ...config,
  setupFiles: ['<rootDir>/.test-dist/test/e2e/setup.js'],
  testMatch: ['<rootDir>/.test-dist/test/e2e/**/*.spec.js'],
  testPathIgnorePatterns: [],
  testTimeout: 120000,
};
