import { authEnvironment } from './helpers/auth-environment.js';
import { describe, expect, it } from 'vitest';
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
      RATE_LIMIT_GLOBAL_LIMIT: 100,
      RATE_LIMIT_GLOBAL_TTL_MS: 60000,
      RATE_LIMIT_AUTH_LIMIT: 5,
      RATE_LIMIT_AUTH_TTL_MS: 60000,
      RATE_LIMIT_AUTH_BLOCK_MS: 300000,
      RATE_LIMIT_ACCOUNT_LIMIT: 3,
      RATE_LIMIT_ACCOUNT_TTL_MS: 60000,
      TRUST_PROXY: 'false',
      REQUEST_BODY_LIMIT_BYTES: 16384,
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

  it.each([
    { TRUST_PROXY: 'true' },
    { TRUST_PROXY: '0' },
    { TRUST_PROXY: '11' },
    { TRUST_PROXY: 'garbage' },
    { TRUST_PROXY: '999.1.1.1' },
    { TRUST_PROXY: '10.0.0.0/33' },
    { TRUST_PROXY: '10.0.0.0/' },
    { TRUST_PROXY: '10.0.0.0/0' },
    { TRUST_PROXY: '0.0.0.0/0' },
    { TRUST_PROXY: '::/0' },
    { TRUST_PROXY: '2001:db8::/0' },
    { TRUST_PROXY: '::/' },
    { TRUST_PROXY: '::/129' },
    { TRUST_PROXY: '10.0.0.0/+1' },
    { TRUST_PROXY: '10.0.0.0/1.5' },
    { TRUST_PROXY: '10.0.0.0/ 8' },
    { TRUST_PROXY: '10.0.0.0/00' },
    { TRUST_PROXY: '10.0.0.0/-1' },
    { TRUST_PROXY: '10.0.0.0/abc' },
    { TRUST_PROXY: '' },
    { RATE_LIMIT_GLOBAL_LIMIT: '0' },
    { RATE_LIMIT_AUTH_LIMIT: '0' },
    { RATE_LIMIT_ACCOUNT_LIMIT: '0' },
    { RATE_LIMIT_GLOBAL_TTL_MS: '999' },
    { REQUEST_BODY_LIMIT_BYTES: '1023' },
    { REQUEST_BODY_LIMIT_BYTES: '1048577' },
    { REQUEST_BODY_LIMIT_BYTES: 'abc' },
  ])('rejects invalid security configuration: %j', (invalid) => {
    expect(
      environmentSchema.safeParse({
        ...authEnvironment,
        DATABASE_URL: databaseUrl,
        ...invalid,
      }).success,
    ).toBe(false);
  });

  it.each([
    ['false', 'false'],
    ['1', 1],
    ['10', 10],
    ['loopback', ['loopback']],
    ['127.0.0.1,10.0.0.0/8', ['127.0.0.1', '10.0.0.0/8']],
    ['::1/128', ['::1/128']],
  ] as const)('parses TRUST_PROXY=%s', (value, expected) => {
    expect(
      environmentSchema.parse({
        ...authEnvironment,
        DATABASE_URL: databaseUrl,
        TRUST_PROXY: value,
      }).TRUST_PROXY,
    ).toEqual(expected);
  });
});
