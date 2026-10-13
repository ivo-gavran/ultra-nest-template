import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import type { z } from 'zod';

function readDotenv(path: string): Record<string, string> {
  try {
    return parseEnv(readFileSync(path, 'utf8')) as Record<string, string>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

// Same sources and precedence as ConfigModule: `.env` in the working
// directory, overridden by the process environment. process.env is not
// mutated. Diagnostics list keys and rule messages, never submitted values.
export function loadEnvironment<Schema extends z.ZodType>(
  schema: Schema,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): z.output<Schema> {
  const result = schema.safeParse({
    ...readDotenv(join(cwd, '.env')),
    ...Object.fromEntries(
      Object.entries(env).filter(([, value]) => value !== undefined),
    ),
  });
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Config validation error: ${issues}`);
  }
  return result.data;
}
