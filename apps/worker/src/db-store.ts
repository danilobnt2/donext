import type { EntityBase, Store } from '@donext/shared';
import { count, desc, eq } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Db } from './db';

/** A table that holds entities: its key is exposed as `id`. */
export type EntityTable = SQLiteTable & { id: SQLiteColumn };

/**
 * Where one type of entity lives: its own table. Drizzle's column definitions do the row
 * mapping; the store only adds the entity's `kind` on reads and leaves it out on writes.
 */
export interface Mapping<T extends EntityTable = EntityTable> {
  table: T;
}

/** The entity a Mapping stores: its row plus `kind`. */
type StoredEntity<M extends Mapping, K extends string> = Omit<
  M['table']['$inferSelect'],
  'kind'
> & {
  kind: K;
};

/** One Mapping per type of entity the store holds. */
export type Mappings<E extends EntityBase> = { [K in E['kind']]: Mapping };

type Flat<T> = { [K in keyof T]: T[K] };
type Same<A, B> =
  (<T>() => T extends Flat<A> ? 1 : 2) extends <T>() => T extends Flat<B> ? 1 : 2 ? true : false;

/** Each Mapping as given, or an error message where its table and its entity differ. */
type Checked<E extends EntityBase, M extends Mappings<E>> = {
  [K in keyof M]: K extends E['kind']
    ? Same<StoredEntity<M[K], K>, Extract<E, { kind: K }>> extends true
      ? M[K]
      : `The ${K} table does not match its entity`
    : M[K];
};

/**
 * Declares the Mappings for the entities E. Fails to compile if any table and its entity
 * drift apart, so rows need no mapping code.
 */
export function mappingsFor<E extends EntityBase>() {
  return <const M extends Mappings<E>>(mappings: M & Checked<E, M>): M => mappings;
}

type Row = Record<string, unknown>;

/**
 * The Durable Object's Store, on its Drizzle database, for whatever entities it is given
 * a Mapping for. One table per type of entity. Its queries run synchronously and never wait on I/O, so no other request
 * runs between a write's load and its commit.
 */
export class DbStore<E extends EntityBase> implements Store<E> {
  constructor(
    private readonly db: Db,
    private readonly mappings: Mappings<E>,
  ) {}

  async get<K extends E['kind']>(kind: K, id: string): Promise<Extract<E, { kind: K }> | null> {
    const { table } = this.mappings[kind];
    const row = this.db.select().from(table).where(eq(table.id, id)).get();
    return row ? this.toEntity(kind, row) : null;
  }

  async count(kind: E['kind']): Promise<number> {
    const { table } = this.mappings[kind];
    return this.db.select({ count: count() }).from(table).get()?.count ?? 0;
  }

  async commit(entities: E[]): Promise<void> {
    this.db.transaction((tx) => {
      for (const entity of entities) {
        const { table } = this.mappings[entity.kind as E['kind']];
        const row = { ...entity } as Row;
        delete row.kind;
        tx.insert(table).values(row).onConflictDoUpdate({ target: table.id, set: row }).run();
      }
    });
  }

  /** Every entity of a type, newest id first. */
  list<K extends E['kind']>(kind: K): Extract<E, { kind: K }>[] {
    const { table } = this.mappings[kind];
    return this.db
      .select()
      .from(table)
      .orderBy(desc(table.id))
      .all()
      .map((row) => this.toEntity(kind, row));
  }

  /** Deletes every entity of a type and returns how many there were. */
  deleteAll(kind: E['kind']): number {
    const { table } = this.mappings[kind];
    return this.db.delete(table).returning().all().length;
  }

  private toEntity<K extends E['kind']>(kind: K, row: Row): Extract<E, { kind: K }> {
    return { ...row, kind } as Extract<E, { kind: K }>;
  }
}
