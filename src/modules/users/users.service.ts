import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PasswordsService } from './passwords.service.js';
import { createUserSchema, updateUserSchema } from './schemas/user.schema.js';
import type {
  CreateUserInput,
  PublicUser,
  UpdateUserInput,
} from './schemas/user.schema.js';
import { UsersRepository } from './users.repository.js';

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
}
