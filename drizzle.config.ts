import { loadEnvFile } from 'node:process';
import { defineConfig } from 'drizzle-kit';
import { environmentSchema } from './src/config/environment.js';

try {
  loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
    throw error;
  }
}

const environment = environmentSchema.parse(process.env);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './migrations',
  dbCredentials: { url: environment.DATABASE_URL },
  strict: true,
  verbose: false,
});
