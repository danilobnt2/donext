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
  // One row per version of a To-Do; its newest version is its current state. Length
  // limits live in @donext/shared, so they can change without rebuilding the table. Rows
  // are never updated, only appended and, past Todos.VERSION_LIMIT per To-Do, dropped oldest
  // first. Times are Unix milliseconds. Existing To-Dos become their first version, made
  // by an unidentified app device. Dropping work_items breaks rollback to the previous
  // release, which is accepted.
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
  ) STRICT;
  INSERT INTO todo_versions (
    todo_id, version, title, notes, due_date, state, created_at, change, changed_fields,
    changed_at, device_changed_at, actor_kind, actor_id
  )
  SELECT id, 1, title, '', NULL, state, ms, 'create', '["title","notes","dueDate","state"]', ms, NULL, 'device', NULL
  FROM (
    SELECT *, CAST(round((julianday(created_at) - 2440587.5) * 86400000) AS INTEGER) AS ms
    FROM work_items WHERE type = 'todo'
  );
  DROP TABLE work_items;`,
];

export function migrate(storage: DurableObjectStorage): void {
  migrateTo(storage, MIGRATIONS.length);
}

/** Applies migrations up to `version`. Exported so tests can start from an older schema. */
export function migrateTo(storage: DurableObjectStorage, version: number): void {
  storage.sql.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = storage.sql
    .exec<{ version: number }>('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .one().version;
  MIGRATIONS.slice(applied, version).forEach((sql, index) => {
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
