import { oldestKeptVersion, type EntityBase, type Store } from '@donext/shared';
import { and, desc, eq, getTableColumns, lt, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Db } from './db';

/** A versions table: one row per version, keyed by the item's `id` and its `version`. */
export type EntityTable = SQLiteTable & { id: SQLiteColumn; version: SQLiteColumn };

/**
 * Where one type of entity lives: its own versions table. Drizzle's column definitions do
 * the row mapping; the store only adds the entity's `kind` on reads and leaves it out on
 * writes.
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

/** Walks a table's distinct item ids newest first, one index seek each. */
function itemIds(table: EntityTable): SQL {
  return sql`WITH RECURSIVE ids(id) AS (
    SELECT MAX(${table.id}) FROM ${table}
    UNION ALL
    SELECT (SELECT MAX(${table.id}) FROM ${table} WHERE ${table.id} < ids.id) FROM ids
    WHERE ids.id IS NOT NULL
  )`;
}

/**
 * Each item's newest version, newest item first. Reads grow with the number of items,
 * not with their versions.
 */
export function newestVersions(table: EntityTable): SQL {
  return sql`${itemIds(table)}
    SELECT v.* FROM ids
    JOIN ${table} v ON v.${sql.identifier(table.id.name)} = ids.id
      AND v.version = (SELECT MAX(${table.version}) FROM ${table} WHERE ${table.id} = ids.id)
    ORDER BY ids.id DESC`;
}

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
      .where(eq(table.id, id))
      .orderBy(desc(table.version))
      .limit(1)
      .get();
    return row ? this.toEntity(kind, row) : null;
  }

  async count(kind: E['kind']): Promise<number> {
    return this.countSync(kind);
  }

  async commit(versions: E[]): Promise<void> {
    this.db.transaction((tx) => {
      for (const version of versions) {
        const { table } = this.mappings[version.kind as E['kind']];
        const row = { ...version } as Row;
        delete row.kind;
        tx.insert(table).values(row).run();
        tx.delete(table)
          .where(
            and(eq(table.id, version.id), lt(table.version, oldestKeptVersion(version.version))),
          )
          .run();
      }
    });
  }

  /** Every item's newest version, newest item first. */
  list<K extends E['kind']>(kind: K): Extract<E, { kind: K }>[] {
    const { table } = this.mappings[kind];
    return this.db
      .all<Row>(newestVersions(table))
      .map((row) => this.toEntity(kind, this.decode(table, row)));
  }

  /** An item's versions, newest first, older than `before`. */
  versions<K extends E['kind']>(
    kind: K,
    id: string,
    before: number,
    limit: number,
  ): Extract<E, { kind: K }>[] {
    const { table } = this.mappings[kind];
    return this.db
      .select()
      .from(table)
      .where(and(eq(table.id, id), lt(table.version, before)))
      .orderBy(desc(table.version))
      .limit(limit)
      .all()
      .map((row) => this.toEntity(kind, row));
  }

  /** Deletes every item of a kind with all its versions and returns how many there were. */
  deleteAll(kind: E['kind']): number {
    const { table } = this.mappings[kind];
    return this.db.transaction(() => {
      const items = this.countSync(kind);
      this.db.delete(table).run();
      return items;
    });
  }

  private countSync(kind: E['kind']): number {
    const { table } = this.mappings[kind];
    return (
      this.db.get<{ count: number }>(sql`${itemIds(table)} SELECT COUNT(id) AS count FROM ids`)
        ?.count ?? 0
    );
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
