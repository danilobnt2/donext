import type { Store, Todos } from '@donext/shared';
import { and, count, desc, eq } from 'drizzle-orm';
import type { Db } from './db';
import { workItems } from './db/schema';

/** Every kind of work item the database holds. Tasks join when they arrive. */
export type WorkItem = Todos.Item;

type Type = WorkItem['kind'];
type Row = typeof workItems.$inferSelect;

/**
 * The Durable Object's Store, on the `work_items` table, for every type of work item.
 * Its queries run synchronously and never wait on I/O, so no other request runs between
 * a write's load and its commit.
 */
export class DbStore implements Store<WorkItem> {
  constructor(private readonly db: Db) {}

  async get<K extends Type>(type: K, id: string): Promise<Extract<WorkItem, { kind: K }> | null> {
    const row = this.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.type, type), eq(workItems.id, id)))
      .get();
    return row ? (fromRow(row) as Extract<WorkItem, { kind: K }>) : null;
  }

  async count(type: Type): Promise<number> {
    return (
      this.db.select({ count: count() }).from(workItems).where(eq(workItems.type, type)).get()
        ?.count ?? 0
    );
  }

  async commit(items: WorkItem[]): Promise<void> {
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

  /** Every work item of a type, newest first. */
  list<K extends Type>(type: K): Extract<WorkItem, { kind: K }>[] {
    return this.db
      .select()
      .from(workItems)
      .where(eq(workItems.type, type))
      .orderBy(desc(workItems.id))
      .all()
      .map((row) => fromRow(row) as Extract<WorkItem, { kind: K }>);
  }

  /** Deletes every work item of a type and returns how many there were. */
  deleteAll(type: Type): number {
    return this.db
      .delete(workItems)
      .where(eq(workItems.type, type))
      .returning({ id: workItems.id })
      .all().length;
  }
}

function toRow(item: WorkItem): Row {
  return {
    id: item.id,
    type: item.kind,
    title: item.title,
    state: item.state,
    rev: item.rev,
    createdAt: new Date(item.createdAt).toISOString(),
    updatedAt: new Date(item.updatedAt).toISOString(),
  };
}

function fromRow(row: Row): WorkItem {
  return {
    kind: row.type,
    id: row.id,
    title: row.title,
    state: row.state,
    rev: row.rev,
    createdAt: Date.parse(row.createdAt),
    updatedAt: Date.parse(row.updatedAt),
  } as WorkItem;
}
