import { DurableObject } from 'cloudflare:workers';
import { Todos, write, type Checked, type Todo } from '@donext/shared';
import { openDb } from './db';
import { DbStore } from './db-store';
import { todos } from './db/todos';

/**
 * One user's data. Until sign-in exists, a single shared instance holds every To-Do.
 * The rules live in @donext/shared; this object only routes requests to them and to its
 * storage.
 */
export class UserStore extends DurableObject<Env> {
  private store!: DbStore<Todos.Item>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.store = new DbStore<Todos.Item>(await openDb(ctx.storage), { todo: todos });
    });
  }

  listTodos(): Todo[] {
    return this.store.list('todo').map(toTodo);
  }

  /** Applies a change to a To-Do and returns the To-Do as it now stands. */
  async writeTodo(change: Todos.Change): Promise<Checked<Todo, Todos.ViolationCode>> {
    const result = await write(Todos.kind, this.store, change, Date.now());
    if (!result.ok) return result;
    const todo = result.value.find((item) => item.id === change.id);
    if (!todo) throw new Error(`Writing To-Do ${change.id} did not produce it.`);
    return { ok: true, value: toTodo(todo) };
  }

  /**
   * Deletes every To-Do. Lets anyone clear the shared board of unwanted content until
   * sign-in gives each user their own; remove it then.
   */
  deleteAllTodos(): number {
    return this.store.deleteAll('todo');
  }
}

function toTodo(item: Todos.Item): Todo {
  return {
    id: item.id,
    title: item.title,
    state: item.state,
    createdAt: new Date(item.createdAt).toISOString(),
  };
}
