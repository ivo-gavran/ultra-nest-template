import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DrizzleModule } from '@nestjs/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Environment } from '../config/environment.js';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema> & { $client: Pool };

@Module({
  imports: [
    DrizzleModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) => {
        const pool = new Pool({
          connectionString: config.get('DATABASE_URL', { infer: true }),
          max: 10,
          connectionTimeoutMillis: 5000,
          idleTimeoutMillis: 30000,
        });
        return {
          db: drizzle({ client: pool, schema, logger: false }),
          autoCloseConnection: true,
        };
      },
    }),
  ],
  exports: [DrizzleModule],
})
export class DatabaseModule {}
