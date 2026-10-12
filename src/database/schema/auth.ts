import {
  pgTable,
  text,
  uuid,
  timestamp,
  jsonb,
  index,
  unique,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const authTokenFamilies = pgTable(
  'auth_token_families',
  {
    familyId: text('family_id').primaryKey(),
    sessionId: uuid('session_id').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    familyExpiresAt: timestamp('family_expires_at', {
      withTimezone: true,
    }).notNull(),
    claims: jsonb('claims').$type<Record<string, unknown>>(),
  },
  (table) => [
    index('auth_families_user_idx').on(table.userId),
    unique('auth_family_owner_unique').on(table.familyId, table.userId),
  ],
);

export const authRefreshTokens = pgTable(
  'auth_refresh_tokens',
  {
    id: text('id').primaryKey(),
    familyId: text('family_id').notNull(),
    userId: uuid('user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    claims: jsonb('claims').$type<Record<string, unknown>>(),
  },
  (table) => [
    foreignKey({
      columns: [table.familyId, table.userId],
      foreignColumns: [authTokenFamilies.familyId, authTokenFamilies.userId],
    }).onDelete('cascade'),
    index('auth_refresh_family_idx').on(table.familyId),
  ],
);

// No FK: revocation must also cover a family whose first write is still pending.
export const authRevokedFamilies = pgTable('auth_revoked_families', {
  familyId: text('family_id').primaryKey(),
  revokedAt: timestamp('revoked_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});
