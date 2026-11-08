import type { EntityBase, EntityTable, Store } from '@donext/shared';
import { count, desc, eq } from 'drizzle-orm';
import type { Db } from './db';

/** The table of each kind of entity the store holds, such as the shared `entities`. */
export type Tables<E extends EntityBase> = { [K in E['kind']]: { table: EntityTable } };

type Row = Record<string, unknown>;

/**
 * The Durable Object's Store, on its Drizzle database, for whatever entities it is given
 * tables for. Drizzle's column definitions map rows to entities; the store only adds an
 * entity's `kind` on reads and leaves it out on writes. One table per type of entity. Its queries run synchronously and never wait on I/O, so no other request
 * runs between a write's load and its commit.
 */
export class DbStore<E extends EntityBase> implements Store<E> {
  constructor(
    private readonly db: Db,
    private readonly tables: Tables<E>,
  ) {}

  async get<K extends E['kind']>(kind: K, id: string): Promise<Extract<E, { kind: K }> | null> {
    const { table } = this.tables[kind];
    const row = this.db.select().from(table).where(eq(table.id, id)).get();
    return row ? this.toEntity(kind, row) : null;
  }

  async count(kind: E['kind']): Promise<number> {
    const { table } = this.tables[kind];
    return this.db.select({ count: count() }).from(table).get()?.count ?? 0;
  }

  async commit(entities: E[]): Promise<void> {
    this.db.transaction((tx) => {
      for (const entity of entities) {
        const { table } = this.tables[entity.kind as E['kind']];
        const row = { ...entity } as Row;
        delete row.kind;
        tx.insert(table).values(row).onConflictDoUpdate({ target: table.id, set: row }).run();
      }
    });
  }

  /** Every entity of a type, newest id first. */
  list<K extends E['kind']>(kind: K): Extract<E, { kind: K }>[] {
    const { table } = this.tables[kind];
    return this.db
      .select()
      .from(table)
      .orderBy(desc(table.id))
      .all()
      .map((row) => this.toEntity(kind, row));
  }

  /** Deletes every entity of a type and returns how many there were. */
  deleteAll(kind: E['kind']): number {
    const { table } = this.tables[kind];
    return this.db.delete(table).returning().all().length;
  }

  private toEntity<K extends E['kind']>(kind: K, row: Row): Extract<E, { kind: K }> {
    return { ...row, kind } as Extract<E, { kind: K }>;
  }
}
