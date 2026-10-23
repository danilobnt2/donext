/**
 * Schema of the per-user SQLite database. Each entry runs once, in order, inside the
 * Durable Object the first time it starts after a deploy. Append only: never edit an
 * entry that has shipped.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE work_items (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('todo', 'task')),
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    rev INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // Append-only log of accepted changes. `seq` orders them board-wide and is the sync cursor;
  // `op_id` makes a retried change a no-op.
  `CREATE TABLE work_item_revisions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    op_id TEXT NOT NULL UNIQUE,
    base_rev INTEGER NOT NULL,
    changed_at TEXT NOT NULL,
    client_changed_at TEXT NOT NULL,
    source TEXT NOT NULL,
    changed_fields TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    UNIQUE (item_id, rev)
  )`,
  // To-Dos created before the log existed get their first revision, so devices pull them too.
  `INSERT INTO work_item_revisions
     (item_id, rev, op_id, base_rev, changed_at, client_changed_at, source, changed_fields, snapshot)
   SELECT id, rev, 'migrated-' || id, 0, created_at, created_at, 'system', '["title","state"]',
     json_object('id', id, 'title', title, 'state', state, 'rev', rev,
                 'createdAt', created_at, 'updatedAt', updated_at)
   FROM work_items WHERE type = 'todo' ORDER BY id`,
];

export function migrate(storage: DurableObjectStorage): void {
  storage.sql.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = storage.sql
    .exec<{ version: number }>('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .one().version;
  MIGRATIONS.slice(applied).forEach((sql, index) => {
    storage.transactionSync(() => {
      storage.sql.exec(sql);
      storage.sql.exec(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        applied + index + 1,
        new Date().toISOString(),
      );
    });
  });
}
