import { describe, expect, it } from '@jest/globals';
import { environmentSchema } from '../src/config/environment.js';

const databaseUrl = 'postgresql://test:test@localhost:5432/test';

describe('Environment schema', () => {
  it('provides typed defaults and tolerates unrelated system environment keys', () => {
    expect(
      environmentSchema.parse({ DATABASE_URL: databaseUrl, PATH: '/bin' }),
    ).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      DATABASE_URL: databaseUrl,
      SWAGGER_ENABLED: true,
    });
  });

  it('coerces the port and parses explicit false without treating it as truthy', () => {
    expect(
      environmentSchema.parse({
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
    expect(environmentSchema.safeParse({ DATABASE_URL: value }).success).toBe(
      false,
    );
  });

  it.each(['', ' ', '0', '-1', '65536', '1.5', '0x10', 'abc'])(
    'rejects invalid PORT=%s',
    (value) => {
      expect(
        environmentSchema.safeParse({ DATABASE_URL: databaseUrl, PORT: value })
          .success,
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
      environmentSchema.safeParse({ DATABASE_URL: databaseUrl, ...invalid })
        .success,
    ).toBe(false);
  });

  it('defaults production documentation to disabled', () => {
    expect(
      environmentSchema.parse({
        DATABASE_URL: databaseUrl,
        NODE_ENV: 'production',
      }).SWAGGER_ENABLED,
    ).toBe(false);
  });
});
