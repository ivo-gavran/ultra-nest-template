import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AUTHENTICATION_MODULE_OPTIONS } from '@nestjs/authentication';
import { AppModule } from '../../src/app.module.js';
import { environmentSchema } from '../../src/config/environment.js';
import type { Environment } from '../../src/config/environment.js';
import { configureApplication } from '../../src/configure-application.js';
import { authenticationOptions } from '../../src/modules/auth/auth.options.js';
import { authEnvironment } from './auth-environment.js';
import { CapturingJsonLogger } from './observability.js';

export async function createReleaseApp(
  databaseUrl: string,
  options: {
    controllers?: Type<unknown>[];
    now?: () => number;
    trustProxy?: string;
  } = {},
) {
  // No copied .env/shell settings and no reduced scrypt or raised rate limits.
  const config = new ConfigService<Environment, true>(
    environmentSchema.parse({
      ...authEnvironment,
      NODE_ENV: 'production',
      DATABASE_URL: databaseUrl,
      ...(options.trustProxy ? { TRUST_PROXY: options.trustProxy } : {}),
    }),
  );
  const builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
  })
    .overrideProvider(ConfigService)
    .useValue(config);
  if (options.now) {
    // Official clock injection only: keep real JWT crypto, TTLs and storage.
    const auth = authenticationOptions(config);
    builder.overrideProvider(AUTHENTICATION_MODULE_OPTIONS).useValue({
      ...auth,
      accessToken: { ...auth.accessToken, now: options.now },
    });
  }
  const module = await builder.compile();
  const logger = new CapturingJsonLogger('release-e2e');
  const app = module.createNestApplication({ logger, bodyParser: false });
  configureApplication(app);
  try {
    await app.listen(0, '127.0.0.1');
    return { app, logger, base: `${await app.getUrl()}/api/v1` };
  } catch (error) {
    await app.close();
    throw error;
  }
}
