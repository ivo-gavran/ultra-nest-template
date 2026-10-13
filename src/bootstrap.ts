import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { configureApplication } from './configure-application.js';
import type { Environment } from './config/environment.js';
import type { TelemetryEnvironment } from './config/telemetry.js';
import { JsonLogger } from './modules/observability/json-logger.js';

export async function bootstrap(telemetry: TelemetryEnvironment) {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: new JsonLogger(telemetry.OTEL_SERVICE_NAME),
  });
  configureApplication(app);
  app.enableShutdownHooks();
  const config = app.get(ConfigService<Environment, true>);
  await app.listen(config.get('PORT', { infer: true }));
}
