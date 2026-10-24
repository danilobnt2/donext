import type { EntityItem, FieldValue, Fields } from '@donext/shared';

/**
 * Where items of one kind are kept, as far as the server's generic code needs to know. The
 * tables are shaped for the data. The only thing sync adds to them is a `seq` column: the
 * user-wide sequence number of the last write to the row.
 */
export interface EntityRepository {
  get(id: string): EntityItem | undefined;
  insert(item: EntityItem, seq: number): void;
  update(item: EntityItem, seq: number): void;
  /** Returns whether there was such an item. */
  delete(id: string): boolean;
  count(): number;
  /** Items last written after `seq`, oldest write first. */
  changedSince(seq: number, limit: number): Array<{ seq: number; item: EntityItem }>;
}

/** How one kind maps onto a table. */
export interface TableMapping {
  entity: string;
  table: string;
  /** For a table that holds several kinds: the column that tells them apart, and this kind's value. */
  discriminator?: { column: string; value: string };
  /** Field name to column name: every field of the kind’s schema, and nothing else. */
  columns: Record<string, string>;
}

/** Columns every mapped table has, so no field can be mapped onto them. `seq` is sync's. */
export const BASE_COLUMNS = ['id', 'rev', 'created_at', 'updated_at', 'seq'];

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

type Row = Record<string, SqlStorageValue>;

/** Builds a repository over a table. Names come from code, never from a request. */
export function tableRepository(sql: SqlStorage, mapping: TableMapping): EntityRepository {
  const { table, discriminator, columns } = mapping;
  const fields = Object.keys(columns);
  const fieldColumns = fields.map((field) => columns[field]!);
  for (const name of [table, discriminator?.column, ...fieldColumns]) {
    if (name !== undefined && !IDENTIFIER.test(name)) {
      throw new Error(`“${name}” is not a valid table or column name.`);
    }
  }

  const select = [...BASE_COLUMNS, ...fieldColumns].join(', ');
  const kind = discriminator ? `${discriminator.column} = ?` : '1 = 1';
  const kindArgs = discriminator ? [discriminator.value] : [];
  const values = (item: EntityItem) => fields.map((field) => bind(item.fields[field] ?? null));

  return {
    get(id) {
      const row = sql
        .exec<Row>(`SELECT ${select} FROM ${table} WHERE id = ? AND ${kind}`, id, ...kindArgs)
        .toArray()[0];
      return row && toItem(mapping, row);
    },

    insert(item, seq) {
      const names = [
        ...BASE_COLUMNS,
        ...(discriminator ? [discriminator.column] : []),
        ...fieldColumns,
      ];
      sql.exec(
        `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
        item.id,
        item.rev,
        item.createdAt,
        item.updatedAt,
        seq,
        ...kindArgs,
        ...values(item),
      );
    },

    update(item, seq) {
      const assignments = [
        'rev = ?',
        'updated_at = ?',
        'seq = ?',
        ...fieldColumns.map((c) => `${c} = ?`),
      ];
      sql.exec(
        `UPDATE ${table} SET ${assignments.join(', ')} WHERE id = ? AND ${kind}`,
        item.rev,
        item.updatedAt,
        seq,
        ...values(item),
        item.id,
        ...kindArgs,
      );
    },

    delete(id) {
      return (
        sql.exec(`DELETE FROM ${table} WHERE id = ? AND ${kind}`, id, ...kindArgs).rowsWritten > 0
      );
    },

    count() {
      return sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM ${table} WHERE ${kind}`,
          ...kindArgs,
        )
        .one().count;
    },

    changedSince(after, limit) {
      return sql
        .exec<Row>(
          `SELECT ${select} FROM ${table} WHERE seq > ? AND ${kind} ORDER BY seq LIMIT ?`,
          after,
          ...kindArgs,
          limit,
        )
        .toArray()
        .map((row) => ({ seq: Number(row.seq), item: toItem(mapping, row) }));
    },
  };
}

function toItem(mapping: TableMapping, row: Row): EntityItem {
  const fields: Fields = {};
  for (const [field, column] of Object.entries(mapping.columns)) {
    const value = row[column];
    if (value instanceof ArrayBuffer) throw new Error(`Column “${column}” holds binary data.`);
    fields[field] = value ?? null;
  }
  return {
    id: String(row.id),
    entity: mapping.entity,
    rev: Number(row.rev),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    fields,
  };
}

function bind(value: FieldValue): SqlStorageValue {
  if (typeof value === 'boolean') {
    throw new Error('Table mappings do not store yes/no fields yet: give the column a type first.');
  }
  return value;
}
