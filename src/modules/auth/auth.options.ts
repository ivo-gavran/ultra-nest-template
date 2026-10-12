import type { AuthenticationModuleOptions } from '@nestjs/authentication';
import type { ConfigService } from '@nestjs/config';
import type { Environment } from '../../config/environment.js';

export function authenticationOptions(
  config: ConfigService<Environment, true>,
): AuthenticationModuleOptions {
  return {
    accessToken: {
      key: Buffer.from(config.get('AUTH_SIGNING_KEY', { infer: true }), 'hex'),
      ttl: '15m',
      type: 'at+jwt',
    },
    refreshToken: { ttl: '7d', absoluteTtl: '7d' },
  };
}
