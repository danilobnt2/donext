import { Todos } from '@donext/shared';
import { sql } from 'drizzle-orm';
import { check, customType, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Schema of the per-user SQLite database. After changing it, run
 * `pnpm --filter @donext/worker db:generate` and commit the migration it writes to
 * `drizzle/`. Never edit a migration that has shipped.
 *
 * Columns read and write the shapes the shared entities use, so rows need no mapping.
 */

/** A time stored as ISO 8601 text, read and written as Unix milliseconds. */
const isoTime = customType<{ data: number; driverData: string }>({
  dataType: () => 'text',
  toDriver: (ms) => new Date(ms).toISOString(),
  fromDriver: (iso) => Date.parse(iso),
});

export const workItems = sqliteTable(
  'work_items',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: ['todo', 'task'] }).notNull(),
    title: text('title').notNull(),
    state: text('state', { enum: Todos.STATES }).notNull(),
    rev: integer('rev').notNull(),
    createdAt: isoTime('created_at').notNull(),
    updatedAt: isoTime('updated_at').notNull(),
  },
  (table) => [check('work_items_type', sql`${table.type} IN ('todo', 'task')`)],
);
