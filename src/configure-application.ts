import { StandardSchemaValidationPipe } from '@nestjs/common';
import type { RequestHandler } from 'express';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Environment } from './config/environment.js';

export function configureApplication(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new StandardSchemaValidationPipe());

  const config = app.get(ConfigService<Environment, true>);
  const origins = config.get('AUTH_TRUSTED_ORIGINS', { infer: true });
  // Before guards, validation and CSRF so rejected auth requests are not cached.
  const authNoStore: RequestHandler = (request, response, next) => {
    if (/^\/api\/v1\/auth(?:\/|$)/i.test(request.path))
      response.setHeader('Cache-Control', 'no-store');
    next();
  };
  app.use(authNoStore);
  app.useSecurityHeaders();
  app.enableCsrfProtection({ trustedOrigins: origins });
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    const options = new DocumentBuilder()
      .setTitle('Ultra Nest Template')
      .setDescription('NestJS starter API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    SwaggerModule.setup(
      'docs',
      app,
      () => SwaggerModule.createDocument(app, options),
      { useGlobalPrefix: false, raw: ['json'] },
    );
  }
}
