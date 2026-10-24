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

  // Sync's versioning, added to the domain table: the user-wide sequence number of the last
  // write to each row. Rows written before sync existed are numbered in the order they were made.
  'ALTER TABLE work_items ADD COLUMN seq INTEGER NOT NULL DEFAULT 0',
  `UPDATE work_items
   SET seq = (SELECT COUNT(*) FROM work_items AS earlier WHERE earlier.id <= work_items.id)`,
  'CREATE INDEX work_items_by_seq ON work_items (seq)',

  // Sync's own state: the sequence counter, the store's epoch, and the newest deletion that has
  // been forgotten (see sync-state.ts).
  'CREATE TABLE sync_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
  `INSERT INTO sync_state (key, value) VALUES
     ('seq', (SELECT COUNT(*) FROM work_items)),
     ('epoch', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
     ('watermark', 0)`,
  // Deleted items, kept only so that devices remove them too, and only up to a cap.
  'CREATE TABLE sync_deletions (seq INTEGER PRIMARY KEY, entity TEXT NOT NULL, id TEXT NOT NULL)',
  // Recent operation ids, so a retried operation is not applied twice. Also capped.
  'CREATE TABLE sync_applied_ops (op_id TEXT PRIMARY KEY)',
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
