import type { EntityBase, Store } from '@donext/shared';
import { and, count, desc, eq, getTableColumns, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Db } from './db';

/** A table that holds entities: its key is exposed as `id`. */
export type EntityTable = SQLiteTable & { id: SQLiteColumn };

/**
 * Where one type of entity lives. Drizzle's column definitions do the row mapping; the
 * store only adds the entity's `kind` on reads and leaves it out on writes.
 */
export interface Mapping<T extends EntityTable = EntityTable> {
  table: T;
  /** For a table that holds several types: the column that tells them apart, and this type's value. */
  scope?: { key: keyof T['$inferSelect'] & string; value: string };
}

/** The entity a Mapping stores: its row, minus any scope column, plus `kind`. */
export type EntityOf<M extends Mapping, K extends string> = Omit<
  M['table']['$inferSelect'],
  NonNullable<M['scope']>['key'] | 'kind'
> & { kind: K };

/** One Mapping per type of entity the store holds. */
export type Mappings<E extends EntityBase> = { [K in E['kind']]: Mapping };

type Row = Record<string, unknown>;

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

  async get<K extends E['kind']>(kind: K, id: string): Promise<Extract<E, { kind: K }> | null> {
    const { table } = this.mappings[kind];
    const row = this.db
      .select()
      .from(table)
      .where(and(eq(table.id, id), this.scope(kind)))
      .get();
    return row ? this.toEntity(kind, row) : null;
  }

  async count(kind: E['kind']): Promise<number> {
    const { table } = this.mappings[kind];
    return this.db.select({ count: count() }).from(table).where(this.scope(kind)).get()?.count ?? 0;
  }

  async commit(entities: E[]): Promise<void> {
    this.db.transaction((tx) => {
      for (const entity of entities) {
        const { table, scope } = this.mappings[entity.kind as E['kind']];
        const row = { ...entity } as Row;
        delete row.kind;
        if (scope) row[scope.key] = scope.value;
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
      .where(this.scope(kind))
      .orderBy(desc(table.id))
      .all()
      .map((row) => this.toEntity(kind, row));
  }

  /** Deletes every entity of a type and returns how many there were. */
  deleteAll(kind: E['kind']): number {
    const { table } = this.mappings[kind];
    return this.db.delete(table).where(this.scope(kind)).returning().all().length;
  }

  private scope(kind: E['kind']): SQL | undefined {
    const { table, scope } = this.mappings[kind];
    if (!scope) return undefined;
    const column = getTableColumns(table)[scope.key];
    if (!column) throw new Error(`${scope.key} is not a column of the ${kind} table.`);
    return eq(column, scope.value);
  }

  private toEntity<K extends E['kind']>(kind: K, row: Row): Extract<E, { kind: K }> {
    const scopeKey = this.mappings[kind].scope?.key;
    const fields = scopeKey
      ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== scopeKey))
      : row;
    return { ...fields, kind } as Extract<E, { kind: K }>;
  }
}
