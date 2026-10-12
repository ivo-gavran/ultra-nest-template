import { authEnvironment } from './helpers/auth-environment.js';
import { describe, expect, it } from '@jest/globals';
import { environmentSchema } from '../src/config/environment.js';

const databaseUrl = 'postgresql://test:test@localhost:5432/test';

describe('Environment schema', () => {
  it.each([
    { AUTH_SIGNING_KEY: undefined },
    { AUTH_SIGNING_KEY: '' },
    { AUTH_SIGNING_KEY: 'short' },
    { AUTH_SIGNING_KEY: 'z'.repeat(64) },
    { AUTH_TRUSTED_ORIGINS: undefined },
    { AUTH_TRUSTED_ORIGINS: '' },
    { AUTH_TRUSTED_ORIGINS: '*' },
    { AUTH_TRUSTED_ORIGINS: 'null' },
    { AUTH_TRUSTED_ORIGINS: 'https://app.test/path' },
    { AUTH_TRUSTED_ORIGINS: 'https://app.test/' },
    { AUTH_TRUSTED_ORIGINS: 'https://user:pass@app.test' },
    { AUTH_TRUSTED_ORIGINS: 'http://app.test' },
    { NODE_ENV: 'production', AUTH_TRUSTED_ORIGINS: 'http://localhost:3000' },
  ])('rejects invalid authentication configuration %#', (invalid) => {
    expect(
      environmentSchema.safeParse({
        ...authEnvironment,
        DATABASE_URL: databaseUrl,
        ...invalid,
      }).success,
    ).toBe(false);
  });

  it('accepts exact HTTPS origin lists and local HTTP only outside production', () => {
    expect(
      environmentSchema.parse({
        ...authEnvironment,
        DATABASE_URL: databaseUrl,
        AUTH_TRUSTED_ORIGINS: 'https://app.test, https://api.test',
      }).AUTH_TRUSTED_ORIGINS,
    ).toEqual(['https://app.test', 'https://api.test']);
    expect(
      environmentSchema.parse({
        ...authEnvironment,
        DATABASE_URL: databaseUrl,
        AUTH_TRUSTED_ORIGINS: 'http://localhost:3000',
      }).AUTH_TRUSTED_ORIGINS,
    ).toEqual(['http://localhost:3000']);
  });
  it('provides typed defaults and tolerates unrelated system environment keys', () => {
    expect(
      environmentSchema.parse({
        ...authEnvironment,
        DATABASE_URL: databaseUrl,
        PATH: '/bin',
      }),
    ).toEqual({
      AUTH_SIGNING_KEY: authEnvironment.AUTH_SIGNING_KEY,
      AUTH_TRUSTED_ORIGINS: [authEnvironment.AUTH_TRUSTED_ORIGINS],
      NODE_ENV: 'development',
      PORT: 3000,
      DATABASE_URL: databaseUrl,
      SWAGGER_ENABLED: true,
    });
  });

  it('coerces the port and parses explicit false without treating it as truthy', () => {
    expect(
      environmentSchema.parse({
        ...authEnvironment,
        DATABASE_URL: databaseUrl,
        PORT: '65535',
        SWAGGER_ENABLED: 'false',
      }),
    ).toMatchObject({ PORT: 65535, SWAGGER_ENABLED: false });
  });

  it.each([
    undefined,
    '',
    'not-a-url',
    'https://localhost/test',
    'postgresql://localhost',
    'postgresql:///test',
  ])('rejects missing or invalid DATABASE_URL=%s', (value) => {
    expect(
      environmentSchema.safeParse({ ...authEnvironment, DATABASE_URL: value })
        .success,
    ).toBe(false);
  });

  it.each(['', ' ', '0', '-1', '65536', '1.5', '0x10', 'abc'])(
    'rejects invalid PORT=%s',
    (value) => {
      expect(
        environmentSchema.safeParse({
          ...authEnvironment,
          DATABASE_URL: databaseUrl,
          PORT: value,
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    { NODE_ENV: 'staging' },
    { NODE_ENV: '' },
    { SWAGGER_ENABLED: '1' },
    { SWAGGER_ENABLED: 'FALSE' },
    { SWAGGER_ENABLED: '' },
  ])('rejects invalid flags: %j', (invalid) => {
    expect(
      environmentSchema.safeParse({
        ...authEnvironment,
        DATABASE_URL: databaseUrl,
        ...invalid,
      }).success,
    ).toBe(false);
  });

  it('defaults production documentation to disabled', () => {
    expect(
      environmentSchema.parse({
        ...authEnvironment,
        DATABASE_URL: databaseUrl,
        NODE_ENV: 'production',
      }).SWAGGER_ENABLED,
    ).toBe(false);
  });
});
