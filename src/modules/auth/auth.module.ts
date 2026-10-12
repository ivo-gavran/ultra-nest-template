import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticationModule } from '@nestjs/authentication';
import { DatabaseModule } from '../../database/database.module.js';
import { UsersModule } from '../users/users.module.js';
import { authenticationOptions } from './auth.options.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { BearerProvider } from './bearer.provider.js';
import { BrowserOriginGuard } from './browser-origin.guard.js';
import { PostgresRefreshTokenStore } from './storage/postgres-refresh-token.store.js';

@Module({
  imports: [
    AuthenticationModule.forRootAsync({
      inject: [ConfigService],
      useFactory: authenticationOptions,
    }),
    DatabaseModule,
    UsersModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    BearerProvider,
    BrowserOriginGuard,
    PostgresRefreshTokenStore,
  ],
})
export class AuthModule {}
