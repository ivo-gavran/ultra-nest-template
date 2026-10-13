import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { PasswordsService } from './passwords.service.js';
import {
  adminUpdateUserSchema,
  changePasswordSchema,
  createUserSchema,
  updateUserSchema,
  userQuerySchema,
} from './schemas/user.schema.js';
import type {
  CreateUserInput,
  PublicUser,
  UpdateUserInput,
  AdminUpdateUserInput,
  ChangePasswordInput,
  UserQuery,
} from './schemas/user.schema.js';
import { UsersRepository } from './users.repository.js';
import {
  UserEmailConflictError,
  UserNotFoundError,
  UserPasswordChangedError,
} from './users.errors.js';

@Injectable()
export class UsersService {
  constructor(
    private readonly repository: UsersRepository,
    private readonly passwords: PasswordsService,
  ) {}

  async create(input: CreateUserInput): Promise<PublicUser> {
    const data = createUserSchema.parse(input);
    const passwordHash = await this.passwords.hash(data.password);
    return this.repository.create({
      email: data.email,
      passwordHash,
      displayName: data.displayName,
    });
  }

  findById(id: string): Promise<PublicUser | undefined> {
    return this.repository.findById(z.uuid().parse(id));
  }

  findByEmail(email: string): Promise<PublicUser | undefined> {
    return this.repository.findByEmail(email);
  }

  update(id: string, input: UpdateUserInput): Promise<PublicUser | undefined> {
    return this.repository.update(
      z.uuid().parse(id),
      updateUserSchema.parse(input),
    );
  }

  getProfile(id: string): Promise<PublicUser> {
    return this.accountOperation(async () => {
      const user = await this.findById(id);
      if (!user) throw new UserNotFoundError();
      return user;
    });
  }

  updateProfile(id: string, input: UpdateUserInput): Promise<PublicUser> {
    return this.accountOperation(async () => {
      const user = await this.update(id, input);
      if (!user) throw new UserNotFoundError();
      return user;
    });
  }

  list(query: UserQuery) {
    return this.accountOperation(async () => {
      const data = userQuerySchema.parse(query);
      const rows = await this.repository.list(data);
      const items = rows.slice(0, data.limit);
      return {
        items,
        nextCursor: rows.length > data.limit ? items.at(-1)!.id : null,
      };
    });
  }

  updateAsAdmin(actor: PublicUser, id: string, input: AdminUpdateUserInput) {
    return this.accountOperation(async () => {
      if (actor.role !== 'admin') throw new ForbiddenException();
      const target = z.uuid().parse(id).toLowerCase();
      const data = adminUpdateUserSchema.parse(input);
      if (target === actor.id && data.role === 'user')
        throw new ConflictException(
          'Use another administrator to change your role',
        );
      const user = await this.repository.updateAsAdmin(target, data);
      if (!user) throw new UserNotFoundError();
      return user;
    });
  }

  changePassword(
    id: string,
    currentSid: string | undefined,
    input: ChangePasswordInput,
  ) {
    return this.accountOperation(async () => {
      const data = changePasswordSchema.parse(input);
      const hash = await this.repository.findPasswordHash(z.uuid().parse(id));
      if (!hash) throw new UserNotFoundError();
      if (!(await this.passwords.verify(data.currentPassword, hash)))
        throw new BadRequestException('Unable to change password');
      const nextHash = await this.passwords.hash(data.newPassword);
      await this.repository.changePassword(id, hash, nextHash, currentSid);
    });
  }

  deleteSelf(id: string) {
    return this.accountOperation(() =>
      this.repository.deleteAccount(z.uuid().parse(id)),
    );
  }

  deleteAsAdmin(actor: PublicUser, id: string) {
    return this.accountOperation(async () => {
      if (actor.role !== 'admin') throw new ForbiddenException();
      const target = z.uuid().parse(id).toLowerCase();
      if (target === actor.id)
        throw new ConflictException(
          'Use the self-service endpoint to delete your account',
        );
      await this.repository.deleteAccount(target);
    });
  }

  private async accountOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof UserEmailConflictError)
        throw new ConflictException('Email is already in use');
      if (error instanceof UserPasswordChangedError)
        throw new ConflictException(
          'Account credentials changed; retry with current credentials',
        );
      if (error instanceof UserNotFoundError)
        throw new NotFoundException('User not found');
      if (error instanceof z.ZodError)
        throw new BadRequestException('Invalid account input');
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(
        'Account operation temporarily unavailable',
      );
    }
  }
}
