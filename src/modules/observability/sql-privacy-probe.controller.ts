import { Controller, Get } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { InjectDrizzle } from '@nestjs/drizzle';
import { SkipThrottle } from '@nestjs/throttler';
import { sql } from 'drizzle-orm';
import type { Database } from '../../database/database.module.js';

// Test-only route. Registered only when OBSERVABILITY_SQL_PROBE=1 so the
// production-bootstrap integration test can execute a query whose SQL text
// embeds a sensitive literal. Never enable in Compose or production.
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
