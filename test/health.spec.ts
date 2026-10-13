import 'reflect-metadata';
import { deferred } from './helpers/deferred.js';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { HealthCheckService } from '@nestjs/terminus';
import type { PoolClient } from 'pg';
import type { Database } from '../src/database/database.module.js';
import { HealthController } from '../src/modules/health/health.controller.js';
import {
  HEALTH_TIMEOUT_MS,
  PostgresHealthIndicator,
} from '../src/modules/health/postgres-health.indicator.js';

function fixture() {
  const events = new EventEmitter();
  const query = jest
    .fn<(sql: string) => Promise<unknown>>()
    .mockResolvedValue({ rows: [] });
  const release = jest.fn<(destroy?: boolean) => void>();
  const client = Object.assign(events, {
    query,
    release,
  }) as unknown as PoolClient;
  const connect = jest
    .fn<() => Promise<PoolClient>>()
    .mockResolvedValue(client);
  const db = { $client: { connect } } as unknown as Database;
  const indicator = new PostgresHealthIndicator(
    db,
    new HealthIndicatorService(),
  );
  return { indicator, query, release, connect, client };
}

const down = { postgres: { status: 'down' } };
const up = { postgres: { status: 'up' } };
afterEach(() => {
  jest.restoreAllMocks();
});

describe('Health indicator resource ownership', () => {
  it('liveness does not invoke Terminus or PostgreSQL', () => {
    const controller = new HealthController(
      {} as HealthCheckService,
      {} as PostgresHealthIndicator,
    );
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('uses SELECT 1 and returns only a safe status, releasing once', async () => {
    const { indicator, query, release } = fixture();
    expect(await indicator.check()).toEqual(up);
    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(false);
  });

  it('sanitizes acquisition and query failures and recovers', async () => {
    const { indicator, connect, query, release } = fixture();
    connect.mockRejectedValueOnce(
      new Error('postgresql://secret:password@host/db'),
    );
    expect(await indicator.check()).toEqual(down);
    query.mockRejectedValueOnce(new Error('SELECT credentials FROM secrets'));
    expect(await indicator.check()).toEqual(down);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
    expect(await indicator.check()).toEqual(up);
  });

  it('shares concurrent probes without acquiring a connection per request', async () => {
    const { indicator, query, connect, release } = fixture();
    const work = deferred<unknown>();
    query.mockReturnValueOnce(work.promise);
    const checks = Array.from({ length: 50 }, () => indicator.check());
    await Promise.resolve();
    work.resolve({ rows: [] });
    expect(await Promise.all(checks)).toEqual(
      Array.from({ length: 50 }, () => up),
    );
    expect(connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('destroys an active connection on Terminus timeout; does not merely abandon the query', async () => {
    const { indicator, query, release } = fixture();
    const timeout = new AbortController();
    const timer = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeout.signal);
    const entered = deferred<void>();
    const work = deferred<unknown>();
    query.mockImplementationOnce(() => {
      entered.resolve();
      return work.promise;
    });
    release.mockImplementationOnce(() =>
      work.reject(new Error('Connection terminated')),
    );
    const check = indicator.check();
    await entered.promise;
    timeout.abort();
    expect(await check).toEqual(down);
    expect(timer).toHaveBeenCalledWith(HEALTH_TIMEOUT_MS);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
  });

  it('retains a timed-out acquisition slot, rejects new probes, and destroys a late client without querying', async () => {
    const { indicator, connect, query, release, client } = fixture();
    const timeout = new AbortController();
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const acquisition = deferred<PoolClient>();
    connect.mockReturnValueOnce(acquisition.promise);
    const check = indicator.check();
    await Promise.resolve();
    timeout.abort();
    expect(await check).toEqual(down);
    for (let i = 0; i < 50; i++) expect(await indicator.check()).toEqual(down);
    expect(connect).toHaveBeenCalledTimes(1);
    acquisition.resolve(client);
    await acquisition.promise;
    expect(query).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
    jest.restoreAllMocks();
    expect(await indicator.check()).toEqual(up);
  });

  it('a late acquisition rejection is handled and releases the probe slot', async () => {
    const { indicator, connect } = fixture();
    const timeout = new AbortController();
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const acquisition = deferred<PoolClient>();
    connect.mockReturnValueOnce(acquisition.promise);
    const check = indicator.check();
    await Promise.resolve();
    timeout.abort();
    expect(await check).toEqual(down);
    acquisition.reject(new Error('Connection timeout'));
    await Promise.resolve();
    jest.restoreAllMocks();
    expect(await indicator.check()).toEqual(up);
  });

  it('shutdown is idempotent and prevents new acquisitions and late queries', async () => {
    const { indicator, connect, query, release, client } = fixture();
    const acquisition = deferred<PoolClient>();
    connect.mockReturnValueOnce(acquisition.promise);
    const check = indicator.check();
    await Promise.resolve();
    indicator.onModuleDestroy();
    indicator.onModuleDestroy();
    expect(await indicator.check()).toEqual(down);
    acquisition.resolve(client);
    expect(await check).toEqual(down);
    expect(query).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('shutdown destroys only the active health client, exactly once', async () => {
    const { indicator, query, release } = fixture();
    const entered = deferred<void>();
    const work = deferred<unknown>();
    query.mockImplementationOnce(() => {
      entered.resolve();
      return work.promise;
    });
    release.mockImplementationOnce(() =>
      work.reject(new Error('Connection terminated')),
    );
    const check = indicator.check();
    await entered.promise;
    indicator.onModuleDestroy();
    indicator.onModuleDestroy();
    expect(await check).toEqual(down);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
  });
});
