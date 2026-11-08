import type { Actor, Commit, Store, Todos } from '@donext/shared';

type TodoRow = {
  todo_id: string;
  version: number;
  title: string;
  notes: string;
  due_date: string | null;
  state: Todos.State;
  created_at: number;
  change: Todos.ChangeKind;
  changed_fields: string;
  changed_at: number;
  device_changed_at: number | null;
  actor_kind: Actor['kind'];
  actor_id: string | null;
};

/** Walks the distinct To-Do ids newest first, one index seek each. */
const TODO_IDS = `
  WITH RECURSIVE ids(id) AS (
    SELECT MAX(todo_id) FROM todo_versions
    UNION ALL
    SELECT (SELECT MAX(todo_id) FROM todo_versions WHERE todo_id < ids.id) FROM ids
    WHERE ids.id IS NOT NULL
  )`;

/**
 * Each To-Do's newest version. Reads grow with the number of To-Dos, not with their
 * versions.
 */
export const CURRENT_TODOS = `${TODO_IDS}
  SELECT v.* FROM ids
  JOIN todo_versions v ON v.todo_id = ids.id
    AND v.version = (SELECT MAX(version) FROM todo_versions WHERE todo_id = ids.id)`;

/**
 * The Durable Object's Store. Its methods run synchronous SQL and never wait on I/O, so
 * no other request runs between a write's load and its commit.
 */
export class SqlStore implements Store<Todos.Version> {
  constructor(private readonly storage: DurableObjectStorage) {}

  async newest<K extends 'todo'>(_kind: K, id: string) {
    return this.newestTodo(id) as Extract<Todos.Version, { kind: K }> | null;
  }

  async count(): Promise<number> {
    return this.countTodos();
  }

  async commit(commits: Commit<Todos.Version>[]): Promise<void> {
    this.storage.transactionSync(() => {
      for (const { version, keepFrom } of commits) {
        const row = toRow(version);
        this.storage.sql.exec(
          `INSERT INTO todo_versions (${Object.keys(row).join(', ')})
           VALUES (${Object.keys(row)
             .map(() => '?')
             .join(', ')})`,
          ...Object.values(row),
        );
        this.storage.sql.exec(
          'DELETE FROM todo_versions WHERE todo_id = ? AND version < ?',
          version.id,
          keepFrom,
        );
      }
    });
  }

  /** Every To-Do's newest version that is still on the board, newest To-Do first. */
  currentTodos(): Todos.Version[] {
    return this.storage.sql
      .exec<TodoRow>(`${CURRENT_TODOS} WHERE v.state <> 'abandoned' ORDER BY v.todo_id DESC`)
      .toArray()
      .map(toVersion);
  }

  newestTodo(id: string): Todos.Version | null {
    const row = this.storage.sql
      .exec<TodoRow>(
        'SELECT * FROM todo_versions WHERE todo_id = ? ORDER BY version DESC LIMIT 1',
        id,
      )
      .toArray()[0];
    return row ? toVersion(row) : null;
  }

  /** Versions of a To-Do, newest first, older than `before`. */
  todoVersions(id: string, before: number, limit: number): Todos.Version[] {
    return this.storage.sql
      .exec<TodoRow>(
        'SELECT * FROM todo_versions WHERE todo_id = ? AND version < ? ORDER BY version DESC LIMIT ?',
        id,
        before,
        limit,
      )
      .toArray()
      .map(toVersion);
  }

  countTodos(): number {
    return this.storage.sql
      .exec<{ count: number }>(`${TODO_IDS} SELECT COUNT(id) AS count FROM ids`)
      .one().count;
  }

  /** Deletes every To-Do with all its versions and returns how many there were. */
  deleteAllTodos(): number {
    return this.storage.transactionSync(() => {
      const count = this.countTodos();
      this.storage.sql.exec('DELETE FROM todo_versions');
      return count;
    });
  }
}

function toRow(version: Todos.Version): TodoRow {
  return {
    todo_id: version.id,
    version: version.version,
    title: version.data.title,
    notes: version.data.notes,
    due_date: version.data.dueDate,
    state: version.data.state,
    created_at: version.createdAt,
    change: version.change,
    changed_fields: JSON.stringify(version.changedFields),
    changed_at: version.changedAt,
    device_changed_at: version.deviceChangedAt,
    actor_kind: version.actor.kind,
    actor_id: version.actor.id,
  };
}

function toVersion(row: TodoRow): Todos.Version {
  return {
    kind: 'todo',
    id: row.todo_id,
    version: row.version,
    createdAt: row.created_at,
    change: row.change,
    changedFields: JSON.parse(row.changed_fields) as Todos.Field[],
    changedAt: row.changed_at,
    deviceChangedAt: row.device_changed_at,
    actor: { kind: row.actor_kind, id: row.actor_id } as Actor,
    data: { title: row.title, notes: row.notes, dueDate: row.due_date, state: row.state },
  };
}
