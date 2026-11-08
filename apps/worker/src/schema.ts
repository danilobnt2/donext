/**
 * Schema of the per-user SQLite database. Each entry runs once, in order, inside the
 * Durable Object the first time it starts after a deploy.
 *
 * The history was reset before the MVP had real users, discarding the bootstrap schema
 * and its demo data. From the first real user on it is append only: never edit an entry
 * that has shipped.
 */
const MIGRATIONS: readonly string[] = [
  // One row per version of a To-Do; its newest version is its current state. Length
  // limits live in @donext/shared, so they can change without rebuilding the table. Rows
  // are never updated, only appended and, past VERSION_LIMIT per To-Do, dropped
  // oldest first. Times are Unix milliseconds.
  `CREATE TABLE todo_versions (
    todo_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    title TEXT NOT NULL CHECK (title <> ''),
    notes TEXT NOT NULL,
    due_date TEXT CHECK (due_date IS NULL OR date(due_date) IS due_date),
    state TEXT NOT NULL CHECK (state IN ('new', 'active', 'pending', 'done', 'abandoned')),
    created_at INTEGER NOT NULL,
    change TEXT NOT NULL CHECK (change IN ('create', 'edit')),
    changed_fields TEXT NOT NULL CHECK (json_valid(changed_fields) AND json_type(changed_fields) = 'array'),
    changed_at INTEGER NOT NULL,
    device_changed_at INTEGER,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('device', 'system', 'connector')),
    actor_id TEXT CHECK (
      CASE actor_kind WHEN 'system' THEN actor_id IS NULL WHEN 'connector' THEN actor_id IS NOT NULL ELSE 1 END
    ),
    CHECK (actor_kind <> 'system' OR device_changed_at IS NULL),
    PRIMARY KEY (todo_id, version)
  ) STRICT`,
];

export function migrate(storage: DurableObjectStorage): void {
  discardBootstrapSchema(storage);
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

/**
 * Drops the bootstrap schema an object may still hold, so the reset history starts from
 * nothing. Remove once every object has started on the reset schema.
 */
function discardBootstrapSchema(storage: DurableObjectStorage): void {
  const bootstrap = storage.sql
    .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_items'")
    .toArray().length;
  if (!bootstrap) return;
  storage.transactionSync(() => {
    storage.sql.exec('DROP TABLE work_items');
    storage.sql.exec('DROP TABLE schema_migrations');
  });
}
