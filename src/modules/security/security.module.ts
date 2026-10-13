import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { Environment } from '../../config/environment.js';

// Default in-memory ThrottlerStorageService: limits are per-process. See
// docs/security.md for the shared-storage contract for multi-instance use.
export function throttlerOptions(
  config: ConfigService<Environment, true>,
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
        limit: config.get('RATE_LIMIT_AUTH_LIMIT', { infer: true }),
        ttl: config.get('RATE_LIMIT_AUTH_TTL_MS', { infer: true }),
        blockDuration: config.get('RATE_LIMIT_AUTH_BLOCK_MS', {
          infer: true,
        }),
      },
      {
        name: 'account',
        limit: config.get('RATE_LIMIT_ACCOUNT_LIMIT', { infer: true }),
        ttl: config.get('RATE_LIMIT_ACCOUNT_TTL_MS', { infer: true }),
      },
    ],
  };
}

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: throttlerOptions,
    }),
  ],
  // Registered here so it runs before the auth guards registered later.
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class SecurityModule {}
