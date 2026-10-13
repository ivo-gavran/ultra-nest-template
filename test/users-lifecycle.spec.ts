import 'reflect-metadata';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import type { Database } from '../src/database/database.module.js';
import { PasswordsService } from '../src/modules/users/passwords.service.js';
import { UsersRepository } from '../src/modules/users/users.repository.js';
import { UsersService } from '../src/modules/users/users.service.js';
import {
  UserPasswordChangedError,
  UserPersistenceError,
} from '../src/modules/users/users.errors.js';
import {
  adminUpdateUserSchema,
  changePasswordSchema,
  updateUserSchema,
  userQuerySchema,
} from '../src/modules/users/schemas/user.schema.js';

describe('Account password workflow', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const input = {
    currentPassword: 'current password',
    newPassword: 'replacement password',
  };
  let repository: UsersRepository;
  let passwords: PasswordsService;
  let service: UsersService;
  beforeEach(() => {
    repository = new UsersRepository({} as Database);
    passwords = new PasswordsService(new PasswordHasher({ logN: 10 }));
    service = new UsersService(repository, passwords);
    jest
      .spyOn(repository, 'findPasswordHash')
      .mockResolvedValue('internal-hash');
    jest.spyOn(repository, 'changePassword').mockResolvedValue();
    jest.spyOn(passwords, 'hash').mockResolvedValue('replacement-hash');
  });

  it('requires verification before hashing or writing', async () => {
    jest.spyOn(passwords, 'verify').mockResolvedValue(false);
    await expect(
      service.changePassword(id, undefined, input),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(jest.spyOn(passwords, 'hash')).not.toHaveBeenCalled();
    expect(jest.spyOn(repository, 'changePassword')).not.toHaveBeenCalled();
  });

  it('uses the verified hash as the concurrent-write precondition', async () => {
    jest.spyOn(passwords, 'verify').mockResolvedValue(true);
    await service.changePassword(id, undefined, input);
    expect(jest.spyOn(repository, 'changePassword')).toHaveBeenCalledWith(
      id,
      'internal-hash',
      'replacement-hash',
      undefined,
    );
    jest
      .spyOn(repository, 'changePassword')
      .mockRejectedValue(new UserPasswordChangedError());
    await expect(
      service.changePassword(id, undefined, input),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps atomic persistence failure to a safe server error', async () => {
    jest.spyOn(passwords, 'verify').mockResolvedValue(true);
    jest
      .spyOn(repository, 'changePassword')
      .mockRejectedValue(new UserPersistenceError());
    await expect(
      service.changePassword(id, undefined, input),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('Separate account input allowlists', () => {
  it('allows role updates only in the administrative schema', () => {
    expect(adminUpdateUserSchema.safeParse({ role: 'admin' }).success).toBe(
      true,
    );
    expect(updateUserSchema.safeParse({ role: 'admin' }).success).toBe(false);
    for (const schema of [adminUpdateUserSchema, updateUserSchema]) {
      for (const key of [
        'id',
        'passwordHash',
        'password_hash',
        'createdAt',
        'updatedAt',
        'unexpected',
      ])
        expect(
          schema.safeParse({ email: 'user@example.test', [key]: 'forbidden' })
            .success,
        ).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    }
  });
  it('rejects password verification bypass and query expressions', () => {
    for (const input of [
      { newPassword: 'replacement password' },
      { currentPassword: '', newPassword: 'replacement password' },
      { currentPassword: 'old', newPassword: 'short' },
      {
        currentPassword: 'old',
        newPassword: 'replacement password',
        sid: 'chosen',
      },
    ])
      expect(changePasswordSchema.safeParse(input).success).toBe(false);
    for (const query of [
      { sort: 'passwordHash' },
      { sort: 'email desc; --' },
      { order: 'random()' },
      { limit: 101 },
      { offset: 0 },
    ])
      expect(userQuerySchema.safeParse(query).success).toBe(false);
  });
});
