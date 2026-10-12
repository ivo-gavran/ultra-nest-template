import config from './jest.config.js';

/** @type {import('jest').Config} */
export default {
  ...config,
  testMatch: ['<rootDir>/.test-dist/test/integration/**/*.spec.js'],
  testPathIgnorePatterns: [],
  testTimeout: 120000,
};
