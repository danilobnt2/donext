import type { EntityBase, Store } from '@donext/shared';
import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Db } from './db';

/** How one type of entity maps to its table. */
export interface Mapping<E extends EntityBase, T extends SQLiteTable = SQLiteTable> {
  table: T;
  id: SQLiteColumn;
  /** Narrows a table that holds several types of entity to this one. */
  scope?: SQL;
  toRow(entity: E): T['$inferInsert'];
  fromRow(row: T['$inferSelect']): E;
}

/** One Mapping per type of entity the store holds. */
export type Mappings<E extends EntityBase> = {
  [K in E['kind']]: Mapping<Extract<E, { kind: K }>, SQLiteTable>;
};

/**
 * The Durable Object's Store, on its Drizzle database, for whatever entities it is given
 * a Mapping for. Its queries run synchronously and never wait on I/O, so no other request
 * runs between a write's load and its commit.
 */
export class DbStore<E extends EntityBase> implements Store<E> {
  constructor(
    private readonly db: Db,
    private readonly mappings: Mappings<E>,
  ) {}

  async get<K extends E['kind']>(type: K, id: string): Promise<Extract<E, { kind: K }> | null> {
    const m = this.mapping(type);
    const row = this.db
      .select()
      .from(m.table)
      .where(and(eq(m.id, id), m.scope))
      .get();
    return row ? m.fromRow(row) : null;
  }

  async count(type: E['kind']): Promise<number> {
    const m = this.mapping(type);
    return this.db.select({ count: count() }).from(m.table).where(m.scope).get()?.count ?? 0;
  }

  async commit(entities: E[]): Promise<void> {
    this.db.transaction((tx) => {
      for (const entity of entities) {
        const m = this.mapping(entity.kind) as Mapping<E>;
        const row = m.toRow(entity);
        tx.insert(m.table).values(row).onConflictDoUpdate({ target: m.id, set: row }).run();
      }
    });
  }

  /** Every entity of a type, newest id first. */
  list<K extends E['kind']>(type: K): Extract<E, { kind: K }>[] {
    const m = this.mapping(type);
    return this.db
      .select()
      .from(m.table)
      .where(m.scope)
      .orderBy(desc(m.id))
      .all()
      .map((row) => m.fromRow(row));
  }

  /** Deletes every entity of a type and returns how many there were. */
  deleteAll(type: E['kind']): number {
    const m = this.mapping(type);
    return this.db.delete(m.table).where(m.scope).returning().all().length;
  }

  private mapping<K extends E['kind']>(type: K): Mapping<Extract<E, { kind: K }>> {
    return this.mappings[type];
  }
}
