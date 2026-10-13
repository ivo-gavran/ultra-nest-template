import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { PostgresHealthIndicator } from './postgres-health.indicator.js';

@ApiTags('health')
@Public()
@SkipThrottle({ global: true, auth: true, account: true })
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly postgres: PostgresHealthIndicator,
  ) {}

  @Get('live')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Process liveness; no external dependencies' })
  @ApiOkResponse({
    description: 'The process is responsive, including during database outages',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: { status: { type: 'string', enum: ['ok'] } },
    },
  })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: 'PostgreSQL readiness',
    description:
      '200 when PostgreSQL responds within 1 second; 503 on failure, timeout or shutdown. Does not verify migrations.',
  })
  ready() {
    return this.health.check([() => this.postgres.check()]);
  }
}
