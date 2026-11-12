import { Todos, type Actor } from '@donext/shared';
import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Schema of the per-user SQLite database: one table per kind of entity. After changing
 * it, run `pnpm --filter @donext/worker db:generate` and commit the migration it writes
 * to `drizzle/`. Never edit a migration that has shipped.
 *
 * Columns read and write the shapes the shared entities use, so rows need no mapping.
 * Times are Unix milliseconds.
 */

/** The columns of a table whose entities are versions (see versions.ts in @donext/shared). */
function versionColumns<Change extends string>(changes: readonly [Change, ...Change[]]) {
  return {
    version: integer('version').notNull(),
    createdAt: integer('created_at').notNull(),
    change: text('change', { enum: changes }).notNull(),
    changedAt: integer('changed_at').notNull(),
    deviceChangedAt: integer('device_changed_at'),
    actor: text('actor', { mode: 'json' }).$type<Actor>().notNull(),
  };
}

export const todoVersions = sqliteTable(
  'todo_versions',
  {
    id: text('id').primaryKey(),
    todoId: text('todo_id').notNull(),
    ...versionColumns<Todos.ChangeKind>(Todos.CHANGES),
    title: text('title').notNull(),
    notes: text('notes').notNull(),
    dueDate: text('due_date'),
    state: text('state', { enum: Todos.STATES }).notNull(),
  },
  (t) => [
    uniqueIndex('todo_versions_todo_version').on(t.todoId, t.version),
    check('todo_versions_version', sql`${t.version} >= 1`),
    check('todo_versions_change', sql`${t.change} IN ('create', 'edit')`),
    check(
      'todo_versions_actor',
      sql`json_extract(${t.actor}, '$.kind') IN ('device', 'system', 'connector')`,
    ),
    check('todo_versions_title', sql`${t.title} <> ''`),
    check(
      'todo_versions_due_date',
      sql`${t.dueDate} IS NULL OR date(${t.dueDate}) IS ${t.dueDate}`,
    ),
    // Abandoned is stored already; the shared rules gain it with the abandon action.
    check(
      'todo_versions_state',
      sql`${t.state} IN ('new', 'active', 'pending', 'done', 'abandoned')`,
    ),
  ],
);
