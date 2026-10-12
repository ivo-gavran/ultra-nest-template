import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { configureApplication } from './configure-application.js';
import type { Environment } from './config/environment.js';

const app = await NestFactory.create(AppModule);
configureApplication(app);
app.enableShutdownHooks();
const config = app.get(ConfigService<Environment, true>);
await app.listen(config.get('PORT', { infer: true }));
