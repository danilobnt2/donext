import { DurableObject } from 'cloudflare:workers';
import { Todos, write, type Checked, type Meta, type Todo, type TodoVersion } from '@donext/shared';
import { migrate } from './schema';
import { SqlStore } from './sql-store';

/**
 * One user's data. Until sign-in exists, a single shared instance holds every To-Do.
 * The rules live in @donext/shared; this object only routes requests to them and to its
 * SQL storage.
 */
export class UserStore extends DurableObject<Env> {
  private readonly store: SqlStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
    this.store = new SqlStore(ctx.storage);
  }

  /** To-Dos on the board, newest first. */
  listTodos(): Todo[] {
    return this.store.currentTodos().map(toTodo);
  }

  /** Applies a change to a To-Do and returns the To-Do as it now stands. */
  async writeTodo(change: Todos.Change, meta: Meta): Promise<Checked<Todo, Todos.ViolationCode>> {
    const result = await write(Todos.kind, this.store, change, meta, Date.now());
    if (!result.ok) return result;
    const todo =
      result.value.find((version) => version.id === change.id) ?? this.store.newestTodo(change.id);
    if (!todo) throw new Error(`To-Do ${change.id} vanished during its own write.`);
    return { ok: true, value: toTodo(todo) };
  }

  /** Versions of a To-Do, newest first, older than `before` if given. Null if it does not exist. */
  listTodoVersions(id: string, before: number | null, limit: number): TodoVersion[] | null {
    if (!this.store.newestTodo(id)) return null;
    return this.store.todoVersions(id, before ?? Number.MAX_SAFE_INTEGER, limit).map(toApiVersion);
  }

  /**
   * Deletes every To-Do with all its versions. Lets anyone clear the shared board of
   * unwanted content until sign-in gives each user their own; remove it then.
   */
  deleteAllTodos(): number {
    return this.store.deleteAllTodos();
  }
}

function toTodo(version: Todos.Version): Todo {
  return {
    id: version.id,
    ...version.data,
    version: version.version,
    createdAt: new Date(version.createdAt).toISOString(),
    updatedAt: new Date(version.changedAt).toISOString(),
  };
}

function toApiVersion(version: Todos.Version): TodoVersion {
  return {
    version: version.version,
    change: version.change,
    changedFields: version.changedFields,
    changedAt: new Date(version.changedAt).toISOString(),
    deviceChangedAt:
      version.deviceChangedAt === null ? null : new Date(version.deviceChangedAt).toISOString(),
    actor: version.actor,
    todo: version.data,
  };
}
