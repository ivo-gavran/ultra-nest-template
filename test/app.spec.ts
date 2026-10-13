import { authEnvironment } from './helpers/auth-environment.js';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { environmentSchema } from '../src/config/environment.js';
import { configureApplication } from '../src/configure-application.js';

describe('Application HTTP conventions', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves the versioned route through the injected service', async () => {
    const response = await fetch(`${url}/api/v1`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Hello World!');
  });

  it.each(['/', '/greetings', '/api/v2', '/api/v1/not-a-route'])(
    'preserves built-in 404 responses for %s',
    async (path) => {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(404);
      if (path.startsWith('/api/v1/')) {
        expect(await response.json()).toMatchObject({
          statusCode: 404,
          error: 'Not Found',
        });
      }
    },
  );

  it.each(['Ivo', 'a', 'a'.repeat(80), '<script>alert(1)</script>'])(
    'accepts a valid name and responds as plain text: %s',
    async (name) => {
      const response = await fetch(`${url}/api/v1/greetings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(await response.text()).toBe(`Hello ${name}!`);
    },
  );

  it.each([
    ['missing name', {}],
    ['empty name', { name: '' }],
    ['overlong name', { name: 'a'.repeat(81) }],
    ['wrong type', { name: 123 }],
    ['null name', { name: null }],
    ['unknown field', { name: 'Ivo', role: 'admin' }],
    ['array', []],
  ])('rejects %s with a built-in 400 response', async (_label, payload) => {
    const response = await fetch(`${url}/api/v1/greetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({
      statusCode: 400,
      error: 'Bad Request',
      message: expect.any(Array),
    });
  });

  it('rejects malformed JSON using the built-in exception handler', async () => {
    const response = await fetch(`${url}/api/v1/greetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      statusCode: 400,
      error: 'Bad Request',
    });
  });

  it('serves Swagger outside the API prefix with matching Zod request and response schemas', async () => {
    const ui = await fetch(`${url}/docs`);
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain('Swagger UI');
    const response = await fetch(`${url}/docs-json`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as OpenAPIObject;
    expect(Object.keys(document.paths).sort()).toEqual([
      '/api/v1',
      '/api/v1/auth/login',
      '/api/v1/auth/logout',
      '/api/v1/auth/logout-all',
      '/api/v1/auth/refresh',
      '/api/v1/auth/register',
      '/api/v1/auth/sessions',
      '/api/v1/auth/sessions/{id}',
      '/api/v1/greetings',
      '/api/v1/health/live',
      '/api/v1/health/ready',
      '/api/v1/users',
      '/api/v1/users/me',
      '/api/v1/users/me/password',
      '/api/v1/users/{id}',
    ]);
    for (const path of ['/api/v1/health/live', '/api/v1/health/ready']) {
      const endpoint = document.paths[path].get!;
      expect(endpoint.security ?? []).toEqual([]);
      expect(endpoint.responses).toHaveProperty('200');
    }
    expect(
      document.paths['/api/v1/health/ready'].get!.responses,
    ).toHaveProperty('503');
    const sessions = document.paths['/api/v1/auth/sessions'].get!;
    const revoke = document.paths['/api/v1/auth/sessions/{id}'].delete!;
    const logoutAll = document.paths['/api/v1/auth/logout-all'].post!;
    for (const endpoint of [sessions, revoke, logoutAll]) {
      expect(endpoint.security).toEqual([{ bearer: [] }]);
      expect(endpoint.responses).toHaveProperty('401');
      expect(endpoint.responses).toHaveProperty('403');
    }
    expect(sessions.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'limit',
          in: 'query',
          schema: expect.objectContaining({
            minimum: 1,
            maximum: 100,
            default: 20,
          }),
        }),
        expect.objectContaining({
          name: 'after',
          in: 'query',
          schema: expect.objectContaining({ format: 'uuid' }),
        }),
      ]),
    );
    expect(revoke.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'id',
          in: 'path',
          required: true,
          schema: expect.objectContaining({ format: 'uuid' }),
        }),
      ]),
    );
    expect(sessions.responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: {
            additionalProperties: false,
            properties: {
              items: {
                items: {
                  additionalProperties: false,
                  properties: {
                    id: { format: 'uuid' },
                    status: { enum: ['active', 'expired', 'revoked'] },
                    current: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(revoke.responses).toHaveProperty('204');
    expect(logoutAll.responses).toHaveProperty('204');
    for (const path of [
      '/api/v1/users',
      '/api/v1/users/me',
      '/api/v1/users/me/password',
      '/api/v1/users/{id}',
    ]) {
      for (const endpoint of Object.values(document.paths[path])) {
        expect(endpoint).toMatchObject({ security: [{ bearer: [] }] });
      }
    }
    expect(document.paths['/api/v1/users/me'].patch!.requestBody).toMatchObject(
      {
        content: {
          'application/json': {
            schema: {
              additionalProperties: false,
              properties: {
                email: expect.any(Object),
                displayName: expect.any(Object),
              },
            },
          },
        },
      },
    );
    expect(
      document.paths['/api/v1/users/me/password'].patch!.requestBody,
    ).toMatchObject({
      content: {
        'application/json': {
          schema: {
            additionalProperties: false,
            required: ['currentPassword', 'newPassword'],
          },
        },
      },
    });
    expect(
      document.paths['/api/v1/users/{id}'].patch!.requestBody,
    ).toMatchObject({
      content: {
        'application/json': {
          schema: {
            additionalProperties: false,
            properties: { role: { enum: ['user', 'admin'] } },
          },
        },
      },
    });
    expect(document.paths['/api/v1/greetings']?.post?.requestBody).toEqual({
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 80 },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
    });
    expect(
      document.paths['/api/v1/greetings']?.post?.responses['200'],
    ).toMatchObject({
      content: { 'text/plain': { schema: { type: 'string' } } },
    });
    expect(document.paths['/api/v1/greetings']?.post?.responses).toHaveProperty(
      '400',
    );
    expect((await fetch(`${url}/api/v1/docs`)).status).toBe(404);
    expect((await fetch(`${url}/docs-yaml`)).status).toBe(404);
  });
});

describe('Swagger exposure', () => {
  it.each([
    ['production', undefined, 404],
    ['production', 'true', 200],
    ['development', undefined, 200],
    ['development', 'false', 404],
  ])(
    '%s with SWAGGER_ENABLED=%s returns %s',
    async (nodeEnv, enabled, status) => {
      const config = new ConfigService(
        environmentSchema.parse({
          ...authEnvironment,
          NODE_ENV: nodeEnv,
          DATABASE_URL: process.env.DATABASE_URL,
          SWAGGER_ENABLED: enabled,
        }),
      );
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ConfigService)
        .useValue(config)
        .compile();
      const app = moduleRef.createNestApplication({
        logger: false,
        bodyParser: false,
      });
      try {
        configureApplication(app);
        await app.listen(0, '127.0.0.1');
        const url = await app.getUrl();
        for (const path of [
          '/docs',
          '/docs-json',
          '/docs/swagger-ui-init.js',
        ]) {
          expect((await fetch(`${url}${path}`)).status).toBe(status);
        }
      } finally {
        await app.close();
      }
    },
  );
});
