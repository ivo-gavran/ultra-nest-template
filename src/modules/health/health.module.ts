import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { DatabaseModule } from '../../database/database.module.js';
import { HealthController } from './health.controller.js';
import { PostgresHealthIndicator } from './postgres-health.indicator.js';

@Module({
  imports: [
    DatabaseModule,
    TerminusModule.forRoot({
      logger: false,
      gracefulShutdownTimeoutMs: 5000,
    }),
  ],
  controllers: [HealthController],
  providers: [PostgresHealthIndicator],
})
export class HealthModule {}
