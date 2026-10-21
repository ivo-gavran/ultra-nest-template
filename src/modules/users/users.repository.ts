import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../database/database.module.js';
import { users } from '../../database/schema/users.js';
import {
  authTokenFamilies as families,
  authRefreshTokens as tokens,
  authRevokedFamilies as revoked,
} from '../../database/schema/auth.js';
import { emailSchema } from './schemas/user.schema.js';
import type {
  AdminUpdateUserInput,
  PublicUser,
  UpdateUserInput,
  UserQuery,
} from './schemas/user.schema.js';
import {
  UserEmailConflictError,
  UserPersistenceError,
  UserNotFoundError,
  UserPasswordChangedError,
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
  if (
    error instanceof UserNotFoundError ||
    error instanceof UserPasswordChangedError
  )
    throw error;
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

  private async persist<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      return rethrowPersistenceError(error);
    }
  }

  /** Internal account workflow only. Never return this projection over HTTP. */
  async findPasswordHash(id: string): Promise<string | undefined> {
    return this.persist(async () => {
      const [record] = await this.db
        .select({ hash: users.passwordHash })
        .from(users)
        .where(eq(users.id, id));
      return record?.hash;
    });
  }

  async list(query: UserQuery): Promise<PublicUser[]> {
    return this.persist(async () => {
      const anchor = alias(users, 'anchor');
      // Both identifiers and the comparison/order are selected from fixed code.
      const column = query.sort === 'email' ? users.email : users.createdAt;
      const anchorColumn =
        query.sort === 'email' ? anchor.email : anchor.createdAt;
      const compare = query.order === 'asc' ? sql`>` : sql`<`;
      const order = query.order === 'asc' ? asc : desc;
      return await this.db
        .select(publicColumns)
        .from(users)
        .where(
          and(
            query.search
              ? sql`(strpos(lower(${users.email}), lower(${query.search})) > 0
          or strpos(lower(coalesce(${users.displayName}, '')), lower(${query.search})) > 0)`
              : undefined,
            query.after
              ? sql`(${column}, ${users.id}) ${compare} (
          select ${anchorColumn}, ${anchor.id} from ${users} as "anchor"
          where ${anchor.id} = ${query.after}
        )`
              : undefined,
          ),
        )
        .orderBy(order(column), order(users.id))
        .limit(query.limit + 1);
    });
  }

  /** Internal password authentication only; never use this as an HTTP model. */
  async findAuthenticationCredentials(
    input: string,
  ): Promise<{ id: string; passwordHash: string } | undefined> {
    const email = emailSchema.parse(input);
    return this.persist(async () => {
      const [record] = await this.db
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(sql`lower(${users.email})`, email))
        .limit(1);
      return record;
    });
  }

  async create(input: NewUserRecord): Promise<PublicUser> {
    const email = emailSchema.parse(input.email);
    return this.persist(async () => {
      const [user] = await this.db
        .insert(users)
        .values({
          email,
          passwordHash: input.passwordHash,
          displayName: input.displayName,
        })
        .returning(publicColumns);
      return user;
    });
  }

  async findById(id: string): Promise<PublicUser | undefined> {
    return this.persist(async () => {
      const [user] = await this.db
        .select(publicColumns)
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      return user;
    });
  }

  async findByEmail(input: string): Promise<PublicUser | undefined> {
    const email = emailSchema.parse(input);
    return this.persist(async () => {
      const [user] = await this.db
        .select(publicColumns)
        .from(users)
        .where(eq(sql`lower(${users.email})`, email))
        .limit(1);
      return user;
    });
  }

  async update(
    id: string,
    input: UpdateUserInput,
  ): Promise<PublicUser | undefined> {
    // Explicitly discard any privileged fields at this persistence boundary too.
    return this.updateFields(id, {
      email: input.email,
      displayName: input.displayName,
    });
  }

  updateAsAdmin(id: string, input: AdminUpdateUserInput) {
    return this.updateFields(id, input);
  }

  private async updateFields(
    id: string,
    input: AdminUpdateUserInput,
  ): Promise<PublicUser | undefined> {
    const email =
      input.email === undefined ? undefined : emailSchema.parse(input.email);
    return this.persist(async () => {
      const [user] = await this.db
        .update(users)
        .set({
          email,
          displayName: input.displayName,
          role: input.role,
          updatedAt: sql`statement_timestamp()`,
        })
        .where(eq(users.id, id))
        .returning(publicColumns);
      return user;
    });
  }

  async changePassword(
    id: string,
    expectedHash: string,
    passwordHash: string,
    currentSid: string | undefined,
  ): Promise<void> {
    return this.persist(async () => {
      await this.db.transaction(async (tx) => {
        // Same user-first lock as refresh saving/logout-all/deletion. Expensive
        // scrypt runs beforehand; the locked comparison prevents lost updates.
        const [user] = await tx
          .select({ hash: users.passwordHash })
          .from(users)
          .where(eq(users.id, id))
          .for('update');
        if (!user) throw new UserNotFoundError();
        if (user.hash !== expectedHash) throw new UserPasswordChangedError();

        const [current] = currentSid
          ? await tx
              .select({ familyId: families.familyId })
              .from(families)
              .leftJoin(revoked, eq(revoked.familyId, families.familyId))
              .where(
                and(
                  eq(families.userId, id),
                  eq(families.sessionId, currentSid),
                  sql`${families.claims}->>'sid' = ${currentSid.toLowerCase()}`,
                  isNull(revoked.familyId),
                  sql`${families.familyExpiresAt} > statement_timestamp()`,
                  sql`exists (select 1 from ${tokens} where ${tokens.familyId} = ${families.familyId}
              and ${tokens.usedAt} is null and ${tokens.expiresAt} > statement_timestamp())`,
                ),
              )
          : [];
        await tx
          .update(users)
          .set({ passwordHash, updatedAt: sql`statement_timestamp()` })
          .where(eq(users.id, id));
        await tx
          .insert(revoked)
          .select(
            tx
              .select({
                familyId: families.familyId,
                revokedAt: sql<Date>`statement_timestamp()`.as('revoked_at'),
              })
              .from(families)
              .where(
                and(
                  eq(families.userId, id),
                  current ? ne(families.familyId, current.familyId) : undefined,
                ),
              ),
          )
          .onConflictDoNothing();
      });
    });
  }

  async deleteAccount(id: string): Promise<void> {
    return this.persist(async () => {
      await this.db.transaction(async (tx) => {
        const [user] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, id))
          .for('update');
        if (!user) throw new UserNotFoundError();
        // Tombstones intentionally have no FK. Retain them after cascades erase
        // family/token rows, including any preexisting revocation evidence.
        await tx
          .insert(revoked)
          .select(
            tx
              .select({
                familyId: families.familyId,
                revokedAt: sql<Date>`statement_timestamp()`.as('revoked_at'),
              })
              .from(families)
              .where(eq(families.userId, id)),
          )
          .onConflictDoNothing();
        await tx.delete(users).where(eq(users.id, id));
      });
    });
  }
}
