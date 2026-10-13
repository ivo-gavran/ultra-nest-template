import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../database/database.module.js';
import {
  authTokenFamilies as families,
  authRefreshTokens as tokens,
  authRevokedFamilies as revoked,
} from '../../database/schema/index.js';
import type { SessionQuery, SessionPage } from './schemas/session.schema.js';
import { AuthStorageError } from './storage/postgres-refresh-token.store.js';

@Injectable()
export class SessionsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async list(userId: string, query: SessionQuery) {
    try {
      const anchor = alias(families, 'anchor');
      return await this.db
        .select({
          id: families.sessionId,
          createdAt: families.createdAt,
          expiresAt: families.familyExpiresAt,
          status: sql<SessionPage['items'][number]['status']>`case
          when ${revoked.familyId} is not null then 'revoked'
          when ${families.familyExpiresAt} > CURRENT_TIMESTAMP and exists (
            select 1 from ${tokens}
            where ${tokens.familyId} = ${families.familyId}
              and ${tokens.usedAt} is null
              and ${tokens.expiresAt} > CURRENT_TIMESTAMP
          ) then 'active' else 'expired' end`,
        })
        .from(families)
        .leftJoin(revoked, eq(revoked.familyId, families.familyId))
        .where(
          and(
            eq(families.userId, userId),
            query.after
              ? sql`(${families.createdAt}, ${families.sessionId}) < (
            select ${anchor.createdAt}, ${anchor.sessionId} from ${families} as "anchor"
            where ${anchor.sessionId} = ${query.after} and ${anchor.userId} = ${userId}
          )`
              : undefined,
          ),
        )
        .orderBy(desc(families.createdAt), desc(families.sessionId))
        .limit(query.limit + 1);
    } catch {
      // Never let SQL parameters or credentials escape via an error cause.
      throw new AuthStorageError();
    }
  }

  async revoke(userId: string, sessionId: string): Promise<boolean> {
    try {
      // One statement: ownership cannot change between lookup and revocation.
      const inserted = await this.db
        .insert(revoked)
        .select(
          this.db
            .select({
              familyId: families.familyId,
              revokedAt: sql<Date>`CURRENT_TIMESTAMP`.as('revoked_at'),
            })
            .from(families)
            .where(
              and(
                eq(families.userId, userId),
                eq(families.sessionId, sessionId),
              ),
            ),
        )
        .onConflictDoNothing()
        .returning({ inserted: sql<number>`1` });
      return inserted.length > 0;
    } catch {
      throw new AuthStorageError();
    }
  }
}
