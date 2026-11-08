import type { Actor, Commit, Store, VersionBase } from '@donext/shared';

/** A version of any kind, with its data. */
export type Versioned = VersionBase & { data: unknown };

type Row = Record<string, SqlStorageValue>;

/**
 * How one kind's versions map to its SQL table. Every versions table has the same common
 * columns; a Table maps only what differs: the table, its id column, and the data.
 * Names are interpolated into SQL, so they must be code constants, never input.
 */
export interface Table<V extends Versioned> {
  kind: V['kind'];
  name: string;
  idColumn: string;
  dataToRow(data: V['data']): Row;
  dataFromRow(row: Row): V['data'];
}

/** One Table per kind the store holds. */
export type Tables<V extends Versioned> = { [K in V['kind']]: Table<Extract<V, { kind: K }>> };

const IDENTIFIER = /^[a-z_]+$/;

/**
 * The Durable Object's Store, for every kind it is given a Table for. Its methods run
 * synchronous SQL and never wait on I/O, so no other request runs between a write's load
 * and its commit.
 */
export class SqlStore<V extends Versioned> implements Store<V> {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly tables: Tables<V>,
  ) {
    for (const table of Object.values<Table<V>>(this.tables)) {
      identifiers(table.name, table.idColumn);
    }
  }

  async newest<K extends V['kind']>(kind: K, id: string): Promise<Extract<V, { kind: K }> | null> {
    return this.newestSync(kind, id);
  }

  async count(kind: V['kind']): Promise<number> {
    return this.countSync(kind);
  }

  async commit(commits: Commit<V>[]): Promise<void> {
    this.storage.transactionSync(() => {
      for (const { version, keepFrom } of commits) {
        const table = this.table(version.kind);
        const row = toRow(table, version);
        const columns = identifiers(...Object.keys(row));
        this.storage.sql.exec(
          `INSERT INTO ${table.name} (${columns.join(', ')})
           VALUES (${columns.map(() => '?').join(', ')})`,
          ...Object.values(row),
        );
        this.storage.sql.exec(
          `DELETE FROM ${table.name} WHERE ${table.idColumn} = ? AND version < ?`,
          version.id,
          keepFrom,
        );
      }
    });
  }

  newestSync<K extends V['kind']>(kind: K, id: string): Extract<V, { kind: K }> | null {
    const table = this.table(kind);
    const row = this.storage.sql
      .exec<Row>(
        `SELECT * FROM ${table.name} WHERE ${table.idColumn} = ? ORDER BY version DESC LIMIT 1`,
        id,
      )
      .toArray()[0];
    return row ? fromRow(table, row) : null;
  }

  /** Every item's newest version, newest item first. */
  current<K extends V['kind']>(kind: K): Extract<V, { kind: K }>[] {
    const table = this.table(kind);
    return this.storage.sql
      .exec<Row>(`${currentSql(table)} ORDER BY ids.id DESC`)
      .toArray()
      .map((row) => fromRow(table, row));
  }

  /** Versions of an item, newest first, older than `before`. */
  versions<K extends V['kind']>(
    kind: K,
    id: string,
    before: number,
    limit: number,
  ): Extract<V, { kind: K }>[] {
    const table = this.table(kind);
    return this.storage.sql
      .exec<Row>(
        `SELECT * FROM ${table.name} WHERE ${table.idColumn} = ? AND version < ?
         ORDER BY version DESC LIMIT ?`,
        id,
        before,
        limit,
      )
      .toArray()
      .map((row) => fromRow(table, row));
  }

  countSync(kind: V['kind']): number {
    const table = this.table(kind);
    return this.storage.sql
      .exec<{ count: number }>(`${idsSql(table)} SELECT COUNT(id) AS count FROM ids`)
      .one().count;
  }

  /** Deletes every item of a kind with all its versions and returns how many there were. */
  deleteAll(kind: V['kind']): number {
    return this.storage.transactionSync(() => {
      const count = this.countSync(kind);
      this.storage.sql.exec(`DELETE FROM ${this.table(kind).name}`);
      return count;
    });
  }

  private table<K extends V['kind']>(kind: K): Table<Extract<V, { kind: K }>> {
    return this.tables[kind];
  }
}

/** Walks a table's distinct item ids newest first, one index seek each. */
function idsSql(table: Pick<Table<Versioned>, 'name' | 'idColumn'>): string {
  const { name, idColumn: id } = table;
  return `WITH RECURSIVE ids(id) AS (
    SELECT MAX(${id}) FROM ${name}
    UNION ALL
    SELECT (SELECT MAX(${id}) FROM ${name} WHERE ${id} < ids.id) FROM ids
    WHERE ids.id IS NOT NULL
  )`;
}

/** Each item's newest version. Reads grow with the number of items, not their versions. */
export function currentSql(table: Pick<Table<Versioned>, 'name' | 'idColumn'>): string {
  const { name, idColumn: id } = table;
  return `${idsSql(table)}
  SELECT v.* FROM ids
  JOIN ${name} v ON v.${id} = ids.id
    AND v.version = (SELECT MAX(version) FROM ${name} WHERE ${id} = ids.id)`;
}

function toRow<V extends Versioned>(table: Table<V>, version: V): Row {
  return {
    [table.idColumn]: version.id,
    version: version.version,
    created_at: version.createdAt,
    change: version.change,
    changed_fields: JSON.stringify(version.changedFields),
    changed_at: version.changedAt,
    device_changed_at: version.deviceChangedAt,
    actor_kind: version.actor.kind,
    actor_id: version.actor.id,
    ...table.dataToRow(version.data),
  };
}

function fromRow<V extends Versioned>(table: Table<V>, row: Row): V {
  return {
    kind: table.kind,
    id: row[table.idColumn],
    version: row.version,
    createdAt: row.created_at,
    change: row.change,
    changedFields: JSON.parse(row.changed_fields as string),
    changedAt: row.changed_at,
    deviceChangedAt: row.device_changed_at,
    actor: { kind: row.actor_kind, id: row.actor_id } as Actor,
    data: table.dataFromRow(row),
  } as V;
}

function identifiers(...names: string[]): string[] {
  for (const name of names) {
    if (!IDENTIFIER.test(name)) throw new Error(`Not a safe SQL identifier: ${name}`);
  }
  return names;
}
