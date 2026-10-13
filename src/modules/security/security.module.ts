import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { Environment } from '../../config/environment.js';
import { RateLimit } from './rate-limit.policy.js';

// Default in-memory ThrottlerStorageService: limits are per-process. See
// docs/security.md for the shared-storage contract for multi-instance use.
//
// Named throttlers otherwise apply to EVERY route. Use the documented skipIf
// option only on stricter policies; global protection needs no annotation.
// Keep the package's IP tracker (including IPv6 normalization). This guard
// executes before authentication and must not use request.user or body fields.
export function throttlerOptions(
  config: ConfigService<Environment, true>,
  reflector: Reflector,
): ThrottlerModuleOptions {
  return {
    errorMessage: 'Too Many Requests',
    throttlers: [
      {
        name: 'global',
        limit: config.get('RATE_LIMIT_GLOBAL_LIMIT', { infer: true }),
        ttl: config.get('RATE_LIMIT_GLOBAL_TTL_MS', { infer: true }),
      },
      {
        name: 'auth',
        skipIf: (context) =>
          reflector.getAllAndOverride(RateLimit, [
            context.getHandler(),
            context.getClass(),
          ]) !== 'auth',
        limit: config.get('RATE_LIMIT_AUTH_LIMIT', { infer: true }),
        ttl: config.get('RATE_LIMIT_AUTH_TTL_MS', { infer: true }),
        blockDuration: config.get('RATE_LIMIT_AUTH_BLOCK_MS', {
          infer: true,
        }),
      },
      {
        name: 'account',
        skipIf: (context) =>
          reflector.getAllAndOverride(RateLimit, [
            context.getHandler(),
            context.getClass(),
          ]) !== 'account',
        limit: config.get('RATE_LIMIT_ACCOUNT_LIMIT', { infer: true }),
        ttl: config.get('RATE_LIMIT_ACCOUNT_TTL_MS', { infer: true }),
      },
    ],
  };
}

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, Reflector],
      useFactory: throttlerOptions,
    }),
  ],
  // Registered here so it runs before the auth guards registered later.
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class SecurityModule {}
