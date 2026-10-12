/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/.test-dist/test/**/*.spec.js',
    '<rootDir>/.test-dist/src/**/*.spec.js',
  ],
  transform: {},
  clearMocks: true,
  restoreMocks: true,
};
