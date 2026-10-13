import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { Injectable } from '@nestjs/common';
import {
  AuthenticationStorage,
  RefreshTokenError,
} from '@nestjs/authentication';
import type {
  RefreshTokenStore,
  RefreshTokenRecord,
} from '@nestjs/authentication';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../../database/database.module.js';
import {
  authTokenFamilies as families,
  authRefreshTokens as tokens,
  authRevokedFamilies as revoked,
  users,
} from '../../../database/schema/index.js';

export class AuthStorageError extends Error {
  constructor() {
    super('Authentication storage unavailable');
    this.name = 'AuthStorageError';
  }
}

@Injectable()
export class PostgresRefreshTokenStore implements RefreshTokenStore {
  // Request-local application precondition, never a claim or persisted field.
  // The public store contract has no transaction/credential-version argument.
  private readonly verifiedPassword = new AsyncLocalStorage<{
    userId: string;
    hash: string;
  }>();

  withVerifiedPassword<T>(
    userId: string,
    hash: string,
    issue: () => Promise<T>,
  ): Promise<T> {
    return this.verifiedPassword.run({ userId, hash }, issue);
  }

  constructor(
    @InjectDrizzle() private readonly db: Database,
    storage: AuthenticationStorage,
  ) {
    storage.registerSource({ refreshTokens: this });
  }

  // Drizzle errors include SQL parameters. Do not propagate their message/cause.
  private async safely<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RefreshTokenError) throw error;
      throw new AuthStorageError();
    }
  }

  getRefreshToken(id: string): Promise<RefreshTokenRecord | undefined> {
    return this.safely(async () => {
      const [row] = await this.db
        .select({
          id: tokens.id,
          familyId: tokens.familyId,
          userId: tokens.userId,
          createdAt: tokens.createdAt,
          expiresAt: tokens.expiresAt,
          familyExpiresAt: families.familyExpiresAt,
          usedAt: tokens.usedAt,
          claims: tokens.claims,
        })
        .from(tokens)
        .innerJoin(families, eq(tokens.familyId, families.familyId))
        .where(eq(tokens.id, id));
      return (
        row && {
          ...row,
          usedAt: row.usedAt ?? undefined,
          claims: row.claims ?? undefined,
        }
      );
    });
  }

  saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    return this.safely(() =>
      this.db.transaction(async (tx) => {
        // Same lock/order as revokeUserRefreshTokens: a new login after logout-all
        // may survive, but a successor of an older family remains revoked.
        const [owner] = await tx
          .select({ id: users.id, passwordHash: users.passwordHash })
          .from(users)
          .where(eq(users.id, record.userId))
          .for('update');
        if (!owner) throw new RefreshTokenError('invalid');
        const verified = this.verifiedPassword.getStore();
        // A login verified before a concurrent password change must not create
        // a fresh surviving family after that change acquired the user lock.
        if (
          verified &&
          (verified.userId !== record.userId ||
            verified.hash !== owner.passwordHash)
        )
          throw new RefreshTokenError('invalid');
        const sid = record.claims?.sid;
        if (sid !== undefined && !z.uuid().safeParse(sid).success)
          throw new RefreshTokenError('invalid');
        await tx
          .insert(families)
          .values({
            familyId: record.familyId,
            sessionId: typeof sid === 'string' ? sid : randomUUID(),
            userId: record.userId,
            createdAt: record.createdAt,
            familyExpiresAt: record.familyExpiresAt,
            claims: record.claims,
          })
          .onConflictDoNothing({ target: families.familyId });
        const [family] = await tx
          .select()
          .from(families)
          .where(eq(families.familyId, record.familyId));
        // The public contract permits omitted claims on generic sid-less records.
        // App families always carry sid and must preserve their entire claim set.
        const checkClaims =
          family.claims?.sid !== undefined || record.claims !== undefined;
        if (
          family.userId !== record.userId ||
          family.familyExpiresAt.getTime() !==
            record.familyExpiresAt.getTime() ||
          (checkClaims &&
            !isDeepStrictEqual(family.claims ?? undefined, record.claims))
        ) {
          throw new RefreshTokenError('invalid');
        }
        await tx.insert(tokens).values({
          id: record.id,
          familyId: record.familyId,
          userId: record.userId,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          usedAt: record.usedAt,
          claims: record.claims,
        });
      }),
    );
  }

  markRefreshTokenUsed(id: string, at: Date): Promise<boolean> {
    return this.safely(async () => {
      const rows = await this.db
        .update(tokens)
        .set({ usedAt: at })
        .where(and(eq(tokens.id, id), isNull(tokens.usedAt)))
        .returning({ id: tokens.id });
      return rows.length === 1;
    });
  }

  revokeRefreshTokenFamily(familyId: string): Promise<void> {
    return this.safely(async () => {
      await this.db.insert(revoked).values({ familyId }).onConflictDoNothing();
    });
  }

  isRefreshTokenFamilyRevoked(familyId: string): Promise<boolean> {
    return this.safely(async () => {
      const rows = await this.db
        .select({ id: revoked.familyId })
        .from(revoked)
        .where(eq(revoked.familyId, familyId));
      return rows.length > 0;
    });
  }

  revokeUserRefreshTokens(userId: string): Promise<void> {
    return this.safely(() =>
      this.db.transaction(async (tx) => {
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        await tx
          .insert(revoked)
          .select(
            tx
              .select({
                familyId: families.familyId,
                revokedAt: sql<Date>`CURRENT_TIMESTAMP`.as('revoked_at'),
              })
              .from(families)
              .where(eq(families.userId, userId)),
          )
          .onConflictDoNothing();
      }),
    );
  }
}
