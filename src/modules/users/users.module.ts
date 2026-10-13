import { Module } from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import { DatabaseModule } from '../../database/database.module.js';
import { PasswordsService } from './passwords.service.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';
import { UsersController } from './users.controller.js';
import { BrowserOriginGuard } from '../auth/browser-origin.guard.js';

@Module({
  imports: [DatabaseModule],
  controllers: [UsersController],
  providers: [
    { provide: PasswordHasher, useFactory: () => new PasswordHasher() },
    PasswordsService,
    UsersRepository,
    UsersService,
    BrowserOriginGuard,
  ],
  exports: [UsersService, PasswordsService, UsersRepository],
})
export class UsersModule {}
