import { randomBytes } from 'node:crypto';

export const authEnvironment = {
  AUTH_SIGNING_KEY: randomBytes(32).toString('hex'),
  AUTH_TRUSTED_ORIGINS: 'https://app.example.test',
};
