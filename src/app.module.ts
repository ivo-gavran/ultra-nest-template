import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { environmentSchema } from './config/environment.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: environmentSchema,
      skipProcessEnv: true,
    }),
    DatabaseModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
