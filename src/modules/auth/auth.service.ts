import { createHash, randomUUID } from 'node:crypto';
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  ServiceUnavailableException,
  HttpException,
} from '@nestjs/common';
import { TokenService, RefreshTokenError } from '@nestjs/authentication';
import type { TokenPair } from '@nestjs/authentication';
import { UsersService } from '../users/users.service.js';
import { UsersRepository } from '../users/users.repository.js';
import { PasswordsService } from '../users/passwords.service.js';
import { UserEmailConflictError } from '../users/users.errors.js';
import type { CreateUserInput } from '../users/schemas/user.schema.js';
import type { LoginInput } from './schemas/auth.schema.js';
import { PostgresRefreshTokenStore } from './storage/postgres-refresh-token.store.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly credentials: UsersRepository,
    private readonly passwords: PasswordsService,
    private readonly tokens: TokenService,
    private readonly store: PostgresRefreshTokenStore,
  ) {}

  private async safely<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RefreshTokenError)
        throw new UnauthorizedException('Invalid credentials');
      if (error instanceof UserEmailConflictError)
        throw new ConflictException('Unable to register');
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(
        'Authentication temporarily unavailable',
      );
    }
  }

  register(input: CreateUserInput) {
    return this.safely(async () => {
      const user = await this.users.create(input);
      return this.issue(user.id);
    });
  }

  login(input: LoginInput) {
    return this.safely(async () => {
      const record = await this.credentials.findAuthenticationCredentials(
        input.email,
      );
      // Verify even an absent account: the package performs dummy scrypt work.
      const valid = await this.passwords.verify(
        input.password,
        record?.passwordHash,
      );
      if (!valid || !record)
        throw new UnauthorizedException('Invalid credentials');
      return this.issue(record.id);
    });
  }

  refresh(token: string | undefined) {
    return this.safely(async () => {
      if (!token || token.length > 128)
        throw new UnauthorizedException('Invalid credentials');
      const record = await this.store.getRefreshToken(
        createHash('sha256').update(token).digest('base64url'),
      );
      if (!record || !(await this.users.findById(record.userId)))
        throw new UnauthorizedException('Invalid credentials');
      return this.withExpiry(await this.tokens.refresh(token));
    });
  }

  logout(token: string | undefined) {
    return this.safely(async () => {
      if (token) await this.tokens.revoke(token);
    });
  }

  private async issue(userId: string) {
    return this.withExpiry(
      await this.tokens.issue(userId, {
        method: 'password',
        claims: { sid: randomUUID(), amr: ['pwd'] },
      }),
    );
  }

  private async withExpiry(pair: TokenPair) {
    const record = await this.store.getRefreshToken(
      createHash('sha256').update(pair.refreshToken).digest('base64url'),
    );
    if (
      !record ||
      (await this.store.isRefreshTokenFamilyRevoked(record.familyId)) ||
      !(await this.users.findById(record.userId))
    )
      throw new UnauthorizedException('Invalid credentials');
    return { ...pair, refreshExpiresAt: record.expiresAt };
  }
}
