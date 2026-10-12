import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';

describe('Application bootstrap (ESM and dependency injection)', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves the root route through the injected service', async () => {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Hello World!');
  });

  it('returns 404 for an unregistered route', async () => {
    const response = await fetch(`${url}/not-a-route`);
    expect(response.status).toBe(404);
  });
});
