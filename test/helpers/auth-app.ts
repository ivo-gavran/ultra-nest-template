import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
import type { LoggerService, Type } from '@nestjs/common';
import {
  AUTHENTICATION_MODULE_OPTIONS,
  CurrentUser,
  PasswordHasher,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { UsersPolicy } from '../../src/modules/authorization/policies/users.policy.js';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import type { Environment } from '../../src/config/environment.js';
import { environmentSchema } from '../../src/config/environment.js';
import { configureApplication } from '../../src/configure-application.js';
import { authenticationOptions } from '../../src/modules/auth/auth.options.js';
import type { PublicUser } from '../../src/modules/users/schemas/user.schema.js';
import { authEnvironment } from './auth-environment.js';

@Controller('auth-test-protected')
class ProtectedController {
  @Get()
  @Can(UsersPolicy, 'readSelf')
  get(@CurrentUser() user: PublicUser) {
    return { id: user.id, role: user.role };
  }
}

export async function createAuthApp(
  databaseUrl: string,
  now = () => Date.now(),
  logger: false | LoggerService = false,
  origins = authEnvironment.AUTH_TRUSTED_ORIGINS,
  controllers: Type<unknown>[] = [],
  env: Record<string, string> = {},
) {
  const config = new ConfigService<Environment, true>(
    environmentSchema.parse({
      ...authEnvironment,
      // Test apps default to generous limits so unrelated suites stay
      // deterministic; security suites pass tight limits via `env`.
      RATE_LIMIT_GLOBAL_LIMIT: '100000',
      RATE_LIMIT_AUTH_LIMIT: '10000',
      RATE_LIMIT_ACCOUNT_LIMIT: '10000',
      ...env,
      AUTH_TRUSTED_ORIGINS: origins,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
    }),
  );
  const options = authenticationOptions(config);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [ProtectedController, ...controllers],
  })
    .overrideProvider(ConfigService)
    .useValue(config)
    .overrideProvider(PasswordHasher)
    .useValue(new PasswordHasher({ logN: 10 }))
    .overrideProvider(AUTHENTICATION_MODULE_OPTIONS)
    .useValue({
      ...options,
      accessToken: { ...options.accessToken, now },
      refreshToken: { ttl: '7d', absoluteTtl: '7d', now },
    })
    .compile();
  const app = moduleRef.createNestApplication({
    logger,
    bodyParser: false,
  });
  configureApplication(app);
  try {
    await app.listen(0, '127.0.0.1');
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
