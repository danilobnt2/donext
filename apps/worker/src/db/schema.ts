import { Todos, type Actor } from '@donext/shared';
import { sql } from 'drizzle-orm';
import { check, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Schema of the per-user SQLite database. After changing it, run
 * `pnpm --filter @donext/worker db:generate` and commit the migration it writes to
 * `drizzle/`. Never edit a migration that has shipped.
 *
 * Each kind of entity has its own versions table: one row per version of an item, never
 * updated. Columns read and write the shapes the shared entities use, so rows need no
 * mapping. Times are Unix milliseconds.
 */

/** The columns every versions table has; `idColumn` names its item id column. */
function versionColumns<Change extends string, Field extends string>(
  idColumn: string,
  changes: readonly [Change, ...Change[]],
) {
  return {
    id: text(idColumn).notNull(),
    version: integer('version').notNull(),
    createdAt: integer('created_at').notNull(),
    change: text('change', { enum: changes }).notNull(),
    changedFields: text('changed_fields', { mode: 'json' }).$type<Field[]>().notNull(),
    changedAt: integer('changed_at').notNull(),
    deviceChangedAt: integer('device_changed_at'),
    actor: text('actor', { mode: 'json' }).$type<Actor>().notNull(),
  };
}

export const todoVersions = sqliteTable(
  'todo_versions',
  {
    ...versionColumns<Todos.ChangeKind, Todos.Field>('todo_id', Todos.CHANGES),
    title: text('title').notNull(),
    notes: text('notes').notNull(),
    dueDate: text('due_date'),
    state: text('state', { enum: Todos.STATES }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.version] }),
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
