import { DurableObject } from 'cloudflare:workers';
import { TODO_LIMIT, type Todo, type TodoState } from '@donext/shared';
import { count, desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { openDb, type Db } from './db';
import { workItems } from './db/schema';

export type CreateTodoResult = { ok: true; todo: Todo } | { ok: false; reason: 'limit_reached' };

const isTodo = eq(workItems.type, 'todo');

/** One user's data. Until sign-in exists, a single shared instance holds every To-Do. */
export class UserStore extends DurableObject<Env> {
  private db!: Db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.db = await openDb(ctx.storage);
    });
  }

  listTodos(): Todo[] {
    return this.db
      .select({
        id: workItems.id,
        title: workItems.title,
        state: workItems.state,
        createdAt: workItems.createdAt,
      })
      .from(workItems)
      .where(isTodo)
      .orderBy(desc(workItems.id))
      .all()
      .map((row) => ({ ...row, state: row.state as TodoState }));
  }

  createTodo(title: string): CreateTodoResult {
    const todos = this.db.select({ count: count() }).from(workItems).where(isTodo).get();
    if ((todos?.count ?? 0) >= TODO_LIMIT) return { ok: false, reason: 'limit_reached' };

    const now = new Date().toISOString();
    const todo: Todo = { id: ulid(), title, state: 'new', createdAt: now };
    this.db
      .insert(workItems)
      .values({ ...todo, type: 'todo', rev: 1, updatedAt: now })
      .run();
    return { ok: true, todo };
  }

  /**
   * Deletes every To-Do. Lets anyone clear the shared board of unwanted content until
   * sign-in gives each user their own; remove it then.
   */
  deleteAllTodos(): number {
    return this.db.delete(workItems).where(isTodo).returning({ id: workItems.id }).all().length;
  }
}
