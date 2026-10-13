import { Module } from '@nestjs/common';
import { AppAuthorizationModule } from './modules/authorization/authorization.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UsersModule } from './modules/users/users.module.js';
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
    UsersModule,
    // AuthenticationModule is scanned before the global authorization guard.
    AuthModule,
    AppAuthorizationModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
