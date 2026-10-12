import { sql } from 'drizzle-orm';
import { check, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const exampleRecords = pgTable(
  'example_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    label: varchar('label', { length: 80 }).notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      'example_records_label_not_blank',
      sql`length(trim(${table.label})) > 0`,
    ),
  ],
);
