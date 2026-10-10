import { DurableObject } from 'cloudflare:workers';
import { TODO_LIMIT, type Todo, type TodoState } from '@donext/shared';
import { ulid } from 'ulid';
import { migrate } from './schema';

type TodoRow = { id: string; title: string; state: TodoState; created_at: string };

export type CreateTodoResult = { ok: true; todo: Todo } | { ok: false; reason: 'limit_reached' };

/** One user's data. Until sign-in exists, a single shared instance holds every To-Do. */
export class UserStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
  }

  listTodos(): Todo[] {
    return this.ctx.storage.sql
      .exec<TodoRow>(
        "SELECT id, title, state, created_at FROM work_items WHERE type = 'todo' ORDER BY id DESC",
      )
      .toArray()
      .map(toTodo);
  }

  createTodo(title: string): CreateTodoResult {
    const { count } = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM work_items WHERE type = 'todo'")
      .one();
    if (count >= TODO_LIMIT) return { ok: false, reason: 'limit_reached' };

    const now = new Date().toISOString();
    const row: TodoRow = { id: ulid(), title, state: 'new', created_at: now };
    this.ctx.storage.sql.exec(
      "INSERT INTO work_items (id, type, title, state, rev, created_at, updated_at) VALUES (?, 'todo', ?, ?, 1, ?, ?)",
      row.id,
      row.title,
      row.state,
      now,
      now,
    );
    return { ok: true, todo: toTodo(row) };
  }

  /**
   * Deletes every To-Do. Lets anyone clear the shared board of unwanted content until
   * sign-in gives each user their own; remove it then.
   */
  deleteAllTodos(): number {
    return this.ctx.storage.sql.exec("DELETE FROM work_items WHERE type = 'todo'").rowsWritten;
  }
}

function toTodo(row: TodoRow): Todo {
  return { id: row.id, title: row.title, state: row.state, createdAt: row.created_at };
}
