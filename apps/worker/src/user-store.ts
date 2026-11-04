import { DurableObject } from 'cloudflare:workers';
import {
  TODO_LIMIT,
  applyChange,
  oldestKeptVersion,
  type Actor,
  type Todo,
  type TodoChange,
  type TodoChangeKind,
  type TodoData,
  type TodoField,
  type TodoState,
  type TodoVersion,
} from '@donext/shared';
import { ulid } from 'ulid';
import { migrate } from './schema';

type VersionRow = {
  todo_id: string;
  version: number;
  title: string;
  notes: string;
  due_date: string | null;
  state: TodoState;
  created_at: number;
  change: TodoChangeKind;
  changed_fields: string;
  changed_at: number;
  device_changed_at: number | null;
  actor_kind: Actor['kind'];
  actor_id: string | null;
};

/**
 * Walks the distinct To-Do ids newest first, one index seek each, and joins each to its
 * newest version. Reads grow with the number of To-Dos, not with their versions.
 */
export const CURRENT_VERSIONS = `
  WITH RECURSIVE ids(id) AS (
    SELECT MAX(todo_id) FROM todo_versions
    UNION ALL
    SELECT (SELECT MAX(todo_id) FROM todo_versions WHERE todo_id < ids.id) FROM ids
    WHERE ids.id IS NOT NULL
  )
  SELECT v.* FROM ids
  JOIN todo_versions v ON v.todo_id = ids.id
    AND v.version = (SELECT MAX(version) FROM todo_versions WHERE todo_id = ids.id)`;

const COUNT_TODOS = `
  WITH RECURSIVE ids(id) AS (
    SELECT MAX(todo_id) FROM todo_versions
    UNION ALL
    SELECT (SELECT MAX(todo_id) FROM todo_versions WHERE todo_id < ids.id) FROM ids
    WHERE ids.id IS NOT NULL
  )
  SELECT COUNT(id) AS count FROM ids`;

export type WriteMeta = { actor: Actor; deviceChangedAt: number | null };

export type CreateTodoResult = { ok: true; todo: Todo } | { ok: false; reason: 'limit_reached' };

export type EditTodoResult = { ok: true; todo: Todo } | { ok: false; reason: 'not_found' };

/** One user's data. Until sign-in exists, a single shared instance holds every To-Do. */
export class UserStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
  }

  /** To-Dos on the board, newest first. */
  listTodos(): Todo[] {
    return this.ctx.storage.sql
      .exec<VersionRow>(`${CURRENT_VERSIONS} WHERE v.state <> 'abandoned' ORDER BY v.todo_id DESC`)
      .toArray()
      .map(toTodo);
  }

  createTodo(change: TodoChange & { kind: 'create' }, meta: WriteMeta): CreateTodoResult {
    const { count } = this.ctx.storage.sql.exec<{ count: number }>(COUNT_TODOS).one();
    if (count >= TODO_LIMIT) return { ok: false, reason: 'limit_reached' };
    const applied = applyChange(null, change);
    if (!applied.ok) throw new Error(applied.message);
    const now = Date.now();
    const row = this.append(
      ulid(now),
      1,
      now,
      now,
      change.kind,
      applied.data,
      applied.changedFields,
      meta,
    );
    return { ok: true, todo: toTodo(row) };
  }

  /** Appends a version unless the edit changes nothing. */
  editTodo(id: string, change: TodoChange & { kind: 'edit' }, meta: WriteMeta): EditTodoResult {
    const current = this.newestVersion(id);
    if (!current) return { ok: false, reason: 'not_found' };
    const applied = applyChange(toData(current), change);
    if (!applied.ok) throw new Error(applied.message);
    if (applied.changedFields.length === 0) return { ok: true, todo: toTodo(current) };
    const row = this.append(
      id,
      current.version + 1,
      current.created_at,
      Date.now(),
      change.kind,
      applied.data,
      applied.changedFields,
      meta,
    );
    return { ok: true, todo: toTodo(row) };
  }

  /** Versions of a To-Do, newest first, older than `before` if given. Null if it does not exist. */
  listTodoVersions(id: string, before: number | null, limit: number): TodoVersion[] | null {
    if (!this.newestVersion(id)) return null;
    return this.ctx.storage.sql
      .exec<VersionRow>(
        'SELECT * FROM todo_versions WHERE todo_id = ? AND version < ? ORDER BY version DESC LIMIT ?',
        id,
        before ?? Number.MAX_SAFE_INTEGER,
        limit,
      )
      .toArray()
      .map(toVersion);
  }

  /**
   * Deletes every To-Do with all its versions. Lets anyone clear the shared board of
   * unwanted content until sign-in gives each user their own; remove it then.
   */
  deleteAllTodos(): number {
    return this.ctx.storage.transactionSync(() => {
      const { count } = this.ctx.storage.sql.exec<{ count: number }>(COUNT_TODOS).one();
      this.ctx.storage.sql.exec('DELETE FROM todo_versions');
      return count;
    });
  }

  private newestVersion(id: string): VersionRow | null {
    return (
      this.ctx.storage.sql
        .exec<VersionRow>(
          'SELECT * FROM todo_versions WHERE todo_id = ? ORDER BY version DESC LIMIT 1',
          id,
        )
        .toArray()[0] ?? null
    );
  }

  /** Writes a new version and drops the ones past TODO_VERSION_LIMIT, in one transaction. */
  private append(
    id: string,
    version: number,
    createdAt: number,
    changedAt: number,
    change: TodoChangeKind,
    data: TodoData,
    changedFields: TodoField[],
    meta: WriteMeta,
  ): VersionRow {
    const row: VersionRow = {
      todo_id: id,
      version,
      title: data.title,
      notes: data.notes,
      due_date: data.dueDate,
      state: data.state,
      created_at: createdAt,
      change,
      changed_fields: JSON.stringify(changedFields),
      changed_at: changedAt,
      device_changed_at: meta.deviceChangedAt,
      actor_kind: meta.actor.kind,
      actor_id: meta.actor.id,
    };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO todo_versions (${Object.keys(row).join(', ')})
         VALUES (${Object.keys(row)
           .map(() => '?')
           .join(', ')})`,
        ...Object.values(row),
      );
      this.ctx.storage.sql.exec(
        'DELETE FROM todo_versions WHERE todo_id = ? AND version < ?',
        id,
        oldestKeptVersion(version),
      );
    });
    return row;
  }
}

function toData(row: VersionRow): TodoData {
  return { title: row.title, notes: row.notes, dueDate: row.due_date, state: row.state };
}

function toTodo(row: VersionRow): Todo {
  return {
    id: row.todo_id,
    ...toData(row),
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.changed_at).toISOString(),
  };
}

function toVersion(row: VersionRow): TodoVersion {
  return {
    version: row.version,
    change: row.change,
    changedFields: JSON.parse(row.changed_fields) as TodoField[],
    changedAt: new Date(row.changed_at).toISOString(),
    deviceChangedAt:
      row.device_changed_at === null ? null : new Date(row.device_changed_at).toISOString(),
    actor: { kind: row.actor_kind, id: row.actor_id } as Actor,
    todo: toData(row),
  };
}
