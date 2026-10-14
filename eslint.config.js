import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    'dist/**',
    '.test-process-dist/**',
    '.test-manual-dist/**',
    'coverage/**',
  ]),
  { files: ['**/*.js'], extends: [js.configs.recommended] },
  {
    files: [
      'src/**/*.ts',
      'test/**/*.ts',
      'scripts/**/*.ts',
      'drizzle.config.ts',
      'commitlint.config.ts',
      'prettier.config.ts',
      'vitest*.ts',
    ],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  prettier,
);
