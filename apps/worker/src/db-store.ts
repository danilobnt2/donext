import type { Store, Todos } from '@donext/shared';
import { count, desc, eq } from 'drizzle-orm';
import type { Db } from './db';
import { workItems } from './db/schema';

type WorkItemRow = typeof workItems.$inferSelect;

const isTodo = eq(workItems.type, 'todo');

/**
 * The Durable Object's Store, on its Drizzle database. Its queries run synchronously and
 * never wait on I/O, so no other request runs between a write's load and its commit.
 */
export class DbStore implements Store<Todos.Item> {
  constructor(private readonly db: Db) {}

  async get<K extends 'todo'>(_kind: K, id: string) {
    const row = this.db.select().from(workItems).where(eq(workItems.id, id)).get();
    return (row?.type === 'todo' ? toTodo(row) : null) as Extract<Todos.Item, { kind: K }> | null;
  }

  async count(): Promise<number> {
    return this.db.select({ count: count() }).from(workItems).where(isTodo).get()?.count ?? 0;
  }

  async commit(items: Todos.Item[]): Promise<void> {
    this.db.transaction((tx) => {
      for (const item of items) {
        const row = toRow(item);
        tx.insert(workItems)
          .values(row)
          .onConflictDoUpdate({ target: workItems.id, set: row })
          .run();
      }
    });
  }

  /** Every To-Do, newest first. */
  todos(): Todos.Item[] {
    return this.db
      .select()
      .from(workItems)
      .where(isTodo)
      .orderBy(desc(workItems.id))
      .all()
      .map(toTodo);
  }

  /** Deletes every To-Do and returns how many there were. */
  deleteAllTodos(): number {
    return this.db.delete(workItems).where(isTodo).returning({ id: workItems.id }).all().length;
  }
}

function toRow(item: Todos.Item): WorkItemRow {
  return {
    id: item.id,
    type: 'todo',
    title: item.title,
    state: item.state,
    rev: item.rev,
    createdAt: new Date(item.createdAt).toISOString(),
    updatedAt: new Date(item.updatedAt).toISOString(),
  };
}

function toTodo(row: WorkItemRow): Todos.Item {
  return {
    kind: 'todo',
    id: row.id,
    title: row.title,
    state: row.state as Todos.State,
    rev: row.rev,
    createdAt: Date.parse(row.createdAt),
    updatedAt: Date.parse(row.updatedAt),
  };
}
