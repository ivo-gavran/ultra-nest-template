import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import type { PoolClient } from 'pg';
import type { Database } from '../../database/database.module.js';

export const HEALTH_TIMEOUT_MS = 1000;

@Injectable()
export class PostgresHealthIndicator implements OnModuleDestroy {
  private readonly shutdown = new AbortController();
  private pending = false;
  private result?: Promise<HealthIndicatorResult>;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly indicators: HealthIndicatorService,
  ) {}

  onModuleDestroy(): void {
    // Earlier than Terminus's drain delay and Drizzle's pool cleanup.
    // Abort is idempotent; this provider never owns or closes the pool.
    this.shutdown.abort();
  }

  async check(): Promise<HealthIndicatorResult> {
    const indicator = this.indicators.check('postgres');
    if (this.shutdown.signal.aborted) return indicator.down();
    if (this.result) return this.result;
    // A timed-out pool.connect() cannot be canceled. Keep its slot occupied
    // until pg's existing 5s acquisition timeout or a late acquisition settles.
    if (this.pending) return indicator.down();

    this.result = Promise.resolve(
      indicator
        .attempt(({ signal }) => this.probe(signal))
        .withTimeout(HEALTH_TIMEOUT_MS),
    )
      .then((result) =>
        result.postgres.status === 'up' && !this.shutdown.signal.aborted
          ? indicator.up()
          : indicator.down(),
      )
      .finally(() => {
        this.result = undefined;
      });
    return this.result;
  }

  private async probe(timeout: AbortSignal): Promise<void> {
    this.pending = true;
    const signal = AbortSignal.any([timeout, this.shutdown.signal]);
    let client: PoolClient | undefined;
    let released = false;
    const release = (destroy: boolean) => {
      if (!client || released) return;
      released = true;
      client.release(destroy);
    };
    const abort = () => release(true);
    // A checked-out pg client can emit an error independently of its query.
    // Handle it here without logging driver diagnostics or credentials.
    const connectionError = () => release(true);
    try {
      client = await this.db.$client.connect();
      if (signal.aborted) {
        release(true);
        throw new Error('Database unavailable');
      }
      client.on('error', connectionError);
      signal.addEventListener('abort', abort, { once: true });
      // Use Drizzle's existing pg pool directly for explicit client ownership.
      // Terminus abort destroys this connection; a Promise timeout alone does
      // not cancel PostgreSQL work. No session settings leak to other users.
      await client.query('SELECT 1');
      signal.throwIfAborted();
      release(false);
    } catch {
      release(true);
      // Terminus attempt() uses thrown messages in its result. Sanitize here
      // even though check() also projects only the up/down status.
      throw new Error('Database unavailable');
    } finally {
      signal.removeEventListener('abort', abort);
      client?.removeListener('error', connectionError);
      this.pending = false;
    }
  }
}
