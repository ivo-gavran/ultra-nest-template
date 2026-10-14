import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Controller, Get } from '@nestjs/common';
import type {
  BeforeApplicationShutdown,
  INestApplication,
} from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { getDrizzleToken, InjectDrizzle } from '@nestjs/drizzle';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool, PoolClient } from 'pg';
import type { Database } from '../../src/database/database.module.js';
import { HealthController } from '../../src/modules/health/health.controller.js';
import { PostgresHealthIndicator } from '../../src/modules/health/postgres-health.indicator.js';
import { createAuthApp } from '../helpers/auth-app.js';
import { authEnvironment } from '../helpers/auth-environment.js';
import { deferred } from '../helpers/deferred.js';
import { startTestDatabase } from '../helpers/postgres.js';

const exec = promisify(execFile);
const docker = (...args: string[]) => exec('docker', args, { timeout: 30000 });
const healthy = {
  status: 'ok',
  info: { postgres: { status: 'up' } },
  error: {},
  details: { postgres: { status: 'up' } },
};
const unhealthy = {
  status: 'error',
  info: {},
  error: { postgres: { status: 'down' } },
  details: { postgres: { status: 'down' } },
};

// Bounded condition polling only for external PostgreSQL startup, never for
// query/shutdown ordering (those tests use explicit events and barriers).
async function eventuallyReady(url: string) {
  const deadline = Date.now() + 15000;
  do {
    const response = await fetch(`${url}/api/v1/health/ready`);
    if (response.status === 200) return;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error('PostgreSQL did not recover');
}

@Controller('health-test-work')
class InFlightController implements BeforeApplicationShutdown {
  readonly entered = deferred<void>();
  readonly finish = deferred<void>();
  readonly draining = deferred<void>();
  readonly continueShutdown = deferred<void>();

  constructor(@InjectDrizzle() private readonly db: Database) {}

  @Get()
  @Public()
  async work() {
    this.entered.resolve();
    await this.finish.promise;
    await this.db.$client.query('SELECT 1');
    return { completed: true };
  }

  async beforeApplicationShutdown() {
    this.draining.resolve();
    await this.continueShutdown.promise;
  }
}

describe('Public health and lifecycle with real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let pool: Pool;
  let url: string;

  beforeAll(async () => {
    container = await startTestDatabase();
    app = await createAuthApp(
      container.getConnectionUri(),
      undefined,
      false,
      undefined,
      [],
      {
        RATE_LIMIT_GLOBAL_LIMIT: '2',
      },
    );
    pool = app.get<Database>(getDrizzleToken()).$client;
    url = await app.getUrl();
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await container?.stop();
    }
  });

  it('serves public probes repeatedly, with security headers and no health rate limits or liveness queries', async () => {
    const connect = vi.spyOn(pool, 'connect');
    try {
      for (let i = 0; i < 8; i++) {
        const live = await fetch(`${url}/api/v1/health/live`);
        expect(live.status).toBe(200);
        expect(await live.json()).toEqual({ status: 'ok' });
        expect(live.headers.get('x-content-type-options')).toBe('nosniff');
        expect(live.headers.get('cache-control')).toContain('no-store');
      }
      expect(connect).not.toHaveBeenCalled();
      for (let i = 0; i < 8; i++) {
        const ready = await fetch(`${url}/api/v1/health/ready`);
        expect(ready.status).toBe(200);
        expect(await ready.json()).toEqual(healthy);
        expect(ready.headers.get('x-content-type-options')).toBe('nosniff');
        expect(ready.headers.get('cache-control')).toContain('no-store');
        for (const name of ['global', 'auth', 'account']) {
          expect(ready.headers.get(`x-ratelimit-limit-${name}`)).toBeNull();
        }
      }
      expect(pool.waitingCount).toBe(0);
      expect(pool.totalCount).toBe(pool.idleCount);
    } finally {
      connect.mockRestore();
    }
  });

  it('preserves unrelated authentication, authorization and rate limiting', async () => {
    expect((await fetch(`${url}/api/v1/users/me`)).status).toBe(401);
    const registration = await fetch(`${url}/api/v1/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: authEnvironment.AUTH_TRUSTED_ORIGINS,
      },
      body: JSON.stringify({
        email: 'health-guards@example.test',
        password: 'health guards test phrase',
      }),
    });
    expect(registration.status).toBe(201);
    const { accessToken } = (await registration.json()) as {
      accessToken: string;
    };
    const headers = { Authorization: `Bearer ${accessToken}` };
    expect((await fetch(`${url}/api/v1/users`, { headers })).status).toBe(403);
    expect((await fetch(`${url}/api/v1/users/me`, { headers })).status).toBe(
      200,
    );
    expect((await fetch(`${url}/api/v1/users/me`, { headers })).status).toBe(
      429,
    );
    expect((await fetch(`${url}/api/v1/health/ready`)).status).toBe(200);
  });

  it('returns 503 during a real database outage, stays live, and recovers without recreating the app', async () => {
    const unavailable = await container.exec([
      'psql',
      '-U',
      container.getUsername(),
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'ALTER DATABASE starter_test ALLOW_CONNECTIONS false',
      '-c',
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'starter_test'",
    ]);
    try {
      expect(unavailable.exitCode).toBe(0);
      for (let i = 0; i < 4; i++) {
        const ready = await fetch(`${url}/api/v1/health/ready`);
        expect(ready.status).toBe(503);
        expect(await ready.json()).toEqual(unhealthy);
        expect((await fetch(`${url}/api/v1/health/live`)).status).toBe(200);
      }
      expect(pool.waitingCount).toBeLessThanOrEqual(1);
      expect(pool.totalCount).toBeLessThanOrEqual(1);
    } finally {
      const restored = await container.exec([
        'psql',
        '-U',
        container.getUsername(),
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        'ALTER DATABASE starter_test ALLOW_CONNECTIONS true',
      ]);
      expect(restored.exitCode).toBe(0);
    }
    await eventuallyReady(url);
  });

  it('bounds stalled queries and concurrent failed probes, destroys their clients and recovers', async () => {
    await eventuallyReady(url); // Warm an idle connection before pausing PostgreSQL.
    const acquired: PoolClient[] = [];
    const onAcquire = (client: PoolClient) => acquired.push(client);
    pool.on('acquire', onAcquire);
    await docker('pause', container.getId());
    try {
      for (let round = 0; round < 2; round++) {
        const start = performance.now();
        const responses = await Promise.all(
          Array.from({ length: 20 }, () => fetch(`${url}/api/v1/health/ready`)),
        );
        for (const response of responses) {
          expect(response.status).toBe(503);
          expect(await response.json()).toEqual(unhealthy);
        }
        expect(performance.now() - start).toBeLessThan(2500);
        expect(pool.totalCount).toBeLessThanOrEqual(1);
        expect(pool.waitingCount).toBeLessThanOrEqual(1);
        expect((await fetch(`${url}/api/v1/health/live`)).status).toBe(200);
      }
      // The first round acquired the warm client and destroyed it on timeout.
      expect(acquired).toHaveLength(1);
      expect(pool.idleCount).toBe(0);
    } finally {
      pool.removeListener('acquire', onAcquire);
      await docker('unpause', container.getId());
    }
    await eventuallyReady(url);
    expect(pool.waitingCount).toBe(0);
    expect(pool.totalCount).toBe(pool.idleCount);
  });

  it('keeps at most one pending health acquisition when all ten application connections are busy', async () => {
    const held = await Promise.all(
      Array.from({ length: 10 }, () => pool.connect()),
    );
    try {
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => fetch(`${url}/api/v1/health/ready`)),
      );
      for (const response of responses) expect(response.status).toBe(503);
      expect(pool.waitingCount).toBe(1);
      for (let i = 0; i < 10; i++)
        expect((await fetch(`${url}/api/v1/health/ready`)).status).toBe(503);
      expect(pool.waitingCount).toBe(1);
      // Hand the timed-out waiter a client; it must destroy it without a query.
      const client = held.pop()!;
      const query = vi.spyOn(client, 'query');
      const removed = deferred<void>();
      pool.once('remove', () => removed.resolve());
      client.release();
      await removed.promise;
      expect(query).not.toHaveBeenCalled();
      query.mockRestore();
    } finally {
      held.forEach((client) => client.release());
    }
    await eventuallyReady(url);
    expect(pool.waitingCount).toBe(0);
    expect(pool.totalCount).toBe(pool.idleCount);
  });

  it('marks readiness down before drain/cleanup, finishes in-flight SQL, and closes the pool only once', async () => {
    const lifecycleApp = await createAuthApp(
      container.getConnectionUri(),
      undefined,
      false,
      undefined,
      [InFlightController],
    );
    const lifecyclePool = lifecycleApp.get<Database>(getDrizzleToken()).$client;
    const end = vi.spyOn(lifecyclePool, 'end');
    const work = lifecycleApp.get(InFlightController);
    const health = lifecycleApp.get(HealthController);
    const indicator = lifecycleApp.get(PostgresHealthIndicator);
    const base = await lifecycleApp.getUrl();
    const request = fetch(`${base}/api/v1/health-test-work`);
    await work.entered.promise;
    const closing = lifecycleApp.close();
    const closingAgain = lifecycleApp.close();
    try {
      await work.draining.promise;
      expect(lifecyclePool.ended).toBe(false);
      indicator.onModuleDestroy(); // Repeated lifecycle notification is safe.
      const connect = vi.spyOn(lifecyclePool, 'connect');
      try {
        await expect(health.ready()).rejects.toMatchObject({ status: 503 });
        const response = await fetch(`${base}/api/v1/health/ready`);
        expect(response.status).toBe(503);
        expect(connect).not.toHaveBeenCalled();
        expect((await fetch(`${base}/api/v1/health/live`)).status).toBe(200);
      } finally {
        connect.mockRestore();
      }
      work.continueShutdown.resolve();
      work.finish.resolve();
      const response = await request;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ completed: true });
      await Promise.all([closing, closingAgain]);
      await lifecycleApp.close();
      expect(end).toHaveBeenCalledTimes(1);
      expect(lifecyclePool.ended).toBe(true);
      expect(lifecyclePool.totalCount).toBe(0);
      await expect(lifecyclePool.query('SELECT 1')).rejects.toThrow(/end/);
    } finally {
      work.continueShutdown.resolve();
      work.finish.resolve();
      await Promise.all([closing, closingAgain, request]);
      end.mockRestore();
    }
  });
});
