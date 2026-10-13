import { Controller, Get } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { InjectDrizzle } from '@nestjs/drizzle';
import { SkipThrottle } from '@nestjs/throttler';
import { sql } from 'drizzle-orm';
import type { Database } from '../../src/database/database.module.js';

// Imported only by the isolated telemetry bootstrap fixture. Never compiled
// into dist or included in the Docker build context.
export const SQL_PRIVACY_PROBE_LITERAL = 'inline-sql-secret-literal-9f2a';

@Public()
@SkipThrottle({ global: true, auth: true, account: true })
@Controller('observability-sql-probe')
export class SqlPrivacyProbeController {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  @Get()
  async probe(): Promise<{ ok: true }> {
    await this.db.execute(
      sql.raw(`select '${SQL_PRIVACY_PROBE_LITERAL}'::text as probe`),
    );
    return { ok: true };
  }
}
