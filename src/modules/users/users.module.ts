import { Module } from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import { DatabaseModule } from '../../database/database.module.js';
import { PasswordsService } from './passwords.service.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    { provide: PasswordHasher, useFactory: () => new PasswordHasher() },
    PasswordsService,
    UsersRepository,
    UsersService,
  ],
  exports: [UsersService, PasswordsService],
})
export class UsersModule {}
