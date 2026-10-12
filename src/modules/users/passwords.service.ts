import { Injectable } from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import { passwordSchema } from './schemas/user.schema.js';

@Injectable()
export class PasswordsService {
  constructor(private readonly hasher: PasswordHasher) {}

  hash(password: string): Promise<string> {
    return this.hasher.hash(passwordSchema.parse(password));
  }

  verify(password: string, hash: string | null | undefined): Promise<boolean> {
    return this.hasher.verify(password, hash);
  }
}
