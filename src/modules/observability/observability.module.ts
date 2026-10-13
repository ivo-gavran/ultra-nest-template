import { Injectable, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ObservabilityExceptionFilter } from './observability-exception.filter.js';
import { shutdownTelemetry } from './telemetry.js';

// Nest runs shutdown hooks after the HTTP server has closed, so every served
// request is exported before telemetry stops. Bounded by
// OTEL_EXPORTER_OTLP_TIMEOUT.
@Injectable()
class TelemetryShutdown implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await shutdownTelemetry();
  }
}

@Module({
  providers: [
    { provide: APP_FILTER, useClass: ObservabilityExceptionFilter },
    TelemetryShutdown,
  ],
})
export class ObservabilityModule {}
