/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/.test-dist/test/setup-env.js'],
  testMatch: [
    '<rootDir>/.test-dist/test/**/*.spec.js',
    '<rootDir>/.test-dist/src/**/*.spec.js',
  ],
  transform: {},
  clearMocks: true,
  restoreMocks: true,
};
