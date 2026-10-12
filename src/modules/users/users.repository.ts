import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../database/database.module.js';
import { users } from '../../database/schema/users.js';
import { emailSchema } from './schemas/user.schema.js';
import type { PublicUser, UpdateUserInput } from './schemas/user.schema.js';
import {
  UserEmailConflictError,
  UserPersistenceError,
} from './users.errors.js';

type NewUserRecord = Pick<
  typeof users.$inferInsert,
  'email' | 'passwordHash' | 'displayName'
>;

// An allowlist rather than select/returning * keeps credentials out of normal reads.
const publicColumns = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  role: users.role,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

function rethrowPersistenceError(error: unknown): never {
  const cause = error instanceof Error ? error.cause : undefined;
  if (
    cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    cause.code === '23505' &&
    'constraint' in cause &&
    cause.constraint === 'users_email_unique'
  ) {
    throw new UserEmailConflictError();
  }
  // Drizzle errors can contain SQL parameters (including hashes). Never attach
  // the original error as a cause or let it cross the repository boundary.
  throw new UserPersistenceError();
}

@Injectable()
export class UsersRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Internal password authentication only; never use this as an HTTP model. */
  async findAuthenticationCredentials(
    input: string,
  ): Promise<{ id: string; passwordHash: string } | undefined> {
    const email = emailSchema.parse(input);
    try {
      const [record] = await this.db
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(sql`lower(${users.email})`, email))
        .limit(1);
      return record;
    } catch (error) {
      return rethrowPersistenceError(error);
    }
  }

  async create(input: NewUserRecord): Promise<PublicUser> {
    const email = emailSchema.parse(input.email);
    try {
      const [user] = await this.db
        .insert(users)
        .values({
          email,
          passwordHash: input.passwordHash,
          displayName: input.displayName,
        })
        .returning(publicColumns);
      return user;
    } catch (error) {
      return rethrowPersistenceError(error);
    }
  }

  async findById(id: string): Promise<PublicUser | undefined> {
    try {
      const [user] = await this.db
        .select(publicColumns)
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      return user;
    } catch (error) {
      return rethrowPersistenceError(error);
    }
  }

  async findByEmail(input: string): Promise<PublicUser | undefined> {
    const email = emailSchema.parse(input);
    try {
      const [user] = await this.db
        .select(publicColumns)
        .from(users)
        .where(eq(sql`lower(${users.email})`, email))
        .limit(1);
      return user;
    } catch (error) {
      return rethrowPersistenceError(error);
    }
  }

  async update(
    id: string,
    input: UpdateUserInput,
  ): Promise<PublicUser | undefined> {
    const email =
      input.email === undefined ? undefined : emailSchema.parse(input.email);
    try {
      const [user] = await this.db
        .update(users)
        .set({
          email,
          displayName: input.displayName,
          updatedAt: sql`statement_timestamp()`,
        })
        .where(eq(users.id, id))
        .returning(publicColumns);
      return user;
    } catch (error) {
      return rethrowPersistenceError(error);
    }
  }
}
