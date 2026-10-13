import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module.js';
import { configureApplication } from '../../src/configure-application.js';
import type { Environment } from '../../src/config/environment.js';
import type { TelemetryEnvironment } from '../../src/config/telemetry.js';
import { JsonLogger } from '../../src/modules/observability/json-logger.js';
import { SqlPrivacyProbeController } from './sql-privacy-probe.controller.js';

@Module({ imports: [AppModule], controllers: [SqlPrivacyProbeController] })
class PrivacyFixtureModule {}

export async function bootstrapFixture(telemetry: TelemetryEnvironment) {
  const app = await NestFactory.create(PrivacyFixtureModule, {
    bodyParser: false,
    logger: new JsonLogger(telemetry.OTEL_SERVICE_NAME),
  });
  configureApplication(app);
  app.enableShutdownHooks();
  await app.listen(
    app.get(ConfigService<Environment, true>).get('PORT', { infer: true }),
  );
}
