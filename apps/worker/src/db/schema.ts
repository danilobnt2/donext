import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Schema of the per-user SQLite database. After changing it, run
 * `pnpm --filter @donext/worker db:generate` and commit the migration it writes to
 * `drizzle/`. Never edit a migration that has shipped.
 */
export const workItems = sqliteTable(
  'work_items',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: ['todo', 'task'] }).notNull(),
    title: text('title').notNull(),
    state: text('state').notNull(),
    rev: integer('rev').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [check('work_items_type', sql`${table.type} IN ('todo', 'task')`)],
);
