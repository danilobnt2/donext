import type { EntityBase, FieldOf, Query, Store, Writes } from '@donext/shared';
import { and, asc, count, desc, eq, getTableColumns, lt, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Db } from './db';

/** A table that holds one kind of entity: its key is exposed as `id`. */
export type EntityTable = SQLiteTable & { id: SQLiteColumn };

/**
 * Where one kind of entity lives: its own table. Drizzle's column definitions do the row
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

/** One Mapping per kind of entity the store holds. */
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

/** A Filter of any kind, as the store reads it. */
type AnyFilter = { where?: Row; before?: { field: string; value: unknown } };

/** Walks the distinct values of a column, highest first, one index seek each. */
function distinctValues(table: SQLiteTable, column: SQLiteColumn): SQL {
  return sql`WITH RECURSIVE vals(v) AS (
    SELECT MAX(${column}) FROM ${table}
    UNION ALL
    SELECT (SELECT MAX(${column}) FROM ${table} WHERE ${column} < vals.v) FROM vals
    WHERE vals.v IS NOT NULL
  )`;
}

/**
 * For each value of `group`, the row with the highest `order`; highest group first. Reads
 * grow with the number of groups, not with the rows in each, given an index on both.
 */
export function newestPerSql(table: SQLiteTable, group: SQLiteColumn, order: SQLiteColumn): SQL {
  const g = sql.identifier(group.name);
  const o = sql.identifier(order.name);
  return sql`${distinctValues(table, group)}
    SELECT t.* FROM vals
    JOIN ${table} t ON t.${g} = vals.v
      AND t.${o} = (SELECT MAX(${order}) FROM ${table} WHERE ${group} = vals.v)
    ORDER BY vals.v DESC`;
}

/**
 * The Durable Object's Store, on its Drizzle database, for whatever entities it is given
 * a Mapping for. It knows nothing about what entities mean. Its queries run synchronously
 * and never wait on I/O, so no other request runs between a write's load and its commit.
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

  async find<K extends E['kind']>(
    kind: K,
    query: Query<Extract<E, { kind: K }>> = {},
  ): Promise<Extract<E, { kind: K }>[]> {
    return this.findSync(kind, query);
  }

  async count<K extends E['kind']>(
    kind: K,
    distinct?: FieldOf<Extract<E, { kind: K }>>,
  ): Promise<number> {
    return this.countSync(kind, distinct);
  }

  async newestPer<K extends E['kind']>(
    kind: K,
    groupBy: FieldOf<Extract<E, { kind: K }>>,
    orderBy: FieldOf<Extract<E, { kind: K }>>,
  ): Promise<Extract<E, { kind: K }>[]> {
    return this.newestPerSync(kind, groupBy, orderBy);
  }

  async commit(writes: Writes<E>): Promise<void> {
    this.db.transaction((tx) => {
      for (const filter of writes.delete) {
        const { table } = this.mappings[filter.kind as E['kind']];
        tx.delete(table)
          .where(this.where(table, filter as AnyFilter))
          .run();
      }
      for (const entity of writes.put) {
        const { table } = this.mappings[entity.kind as E['kind']];
        const row = { ...entity } as Row;
        delete row.kind;
        tx.insert(table).values(row).onConflictDoUpdate({ target: table.id, set: row }).run();
      }
    });
  }

  findSync<K extends E['kind']>(
    kind: K,
    query: Query<Extract<E, { kind: K }>> = {},
  ): Extract<E, { kind: K }>[] {
    const { table } = this.mappings[kind];
    const order = query.orderBy;
    const column = order && this.column(table, order.field);
    let select = this.db
      .select()
      .from(table)
      .where(this.where(table, query as AnyFilter))
      .$dynamic();
    if (column) select = select.orderBy(order.desc ? desc(column) : asc(column));
    if (query.limit !== undefined) select = select.limit(query.limit);
    return select.all().map((row) => this.toEntity(kind, row));
  }

  countSync<K extends E['kind']>(kind: K, distinct?: FieldOf<Extract<E, { kind: K }>>): number {
    const { table } = this.mappings[kind];
    if (!distinct) return this.db.select({ n: count() }).from(table).get()?.n ?? 0;
    const values = distinctValues(table, this.column(table, distinct));
    return this.db.get<{ n: number }>(sql`${values} SELECT COUNT(v) AS n FROM vals`)?.n ?? 0;
  }

  newestPerSync<K extends E['kind']>(
    kind: K,
    groupBy: FieldOf<Extract<E, { kind: K }>>,
    orderBy: FieldOf<Extract<E, { kind: K }>>,
  ): Extract<E, { kind: K }>[] {
    const { table } = this.mappings[kind];
    const query = newestPerSql(table, this.column(table, groupBy), this.column(table, orderBy));
    return this.db.all<Row>(query).map((row) => this.toEntity(kind, this.decode(table, row)));
  }

  /** Deletes every entity of a kind and returns how many there were. */
  deleteAll(kind: E['kind']): number {
    const { table } = this.mappings[kind];
    return this.db.delete(table).returning({ id: table.id }).all().length;
  }

  private where(table: EntityTable, filter: AnyFilter): SQL | undefined {
    const conditions = Object.entries(filter.where ?? {}).map(([field, value]) =>
      eq(this.column(table, field), value),
    );
    if (filter.before) {
      conditions.push(lt(this.column(table, filter.before.field), filter.before.value));
    }
    return and(...conditions);
  }

  private column(table: EntityTable, field: string): SQLiteColumn {
    const column = getTableColumns(table)[field];
    if (!column) throw new Error(`${field} is not a column of ${table._.name}.`);
    return column;
  }

  /** Maps a raw row, keyed by column name, through the table's column definitions. */
  private decode(table: EntityTable, row: Row): Row {
    return Object.fromEntries(
      Object.entries(getTableColumns(table)).map(([key, column]) => {
        const value = row[column.name];
        return [key, value === null ? null : column.mapFromDriverValue(value)];
      }),
    );
  }

  private toEntity<K extends E['kind']>(kind: K, row: Row): Extract<E, { kind: K }> {
    return { ...row, kind } as Extract<E, { kind: K }>;
  }
}
