import type { EntityItem, FieldValue, Fields } from '@donext/shared';

/**
 * Where items of one kind are kept, as far as the sync code needs to know. How they are
 * kept is up to the kind: its own table, or a table it shares with others, shaped for the
 * data and not for syncing it.
 */
export interface EntityRepository {
  get(id: string): EntityItem | undefined;
  insert(item: EntityItem): void;
  update(item: EntityItem): void;
  /** How many items there are, leaving out those whose `field` equals `value`. */
  count(excluding?: { field: string; value: FieldValue }): number;
}

/** How one kind maps onto a table. Every table has `id`, `rev`, `created_at` and `updated_at`. */
export interface TableMapping {
  entity: string;
  table: string;
  /** For a table that holds several kinds: the column that tells them apart, and this kind's value. */
  discriminator?: { column: string; value: string };
  /** Field name to column name: every field of the kind’s schema, and nothing else. */
  columns: Record<string, string>;
}

/** Columns every mapped table has, so no field can be mapped onto them. */
export const BASE_COLUMNS = ['id', 'rev', 'created_at', 'updated_at'];

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

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
  const kindFilter = discriminator ? ` AND ${discriminator.column} = ?` : '';
  const kindArgs = discriminator ? [discriminator.value] : [];

  type Row = Record<string, SqlStorageValue>;

  return {
    get(id) {
      const row = sql
        .exec<Row>(`SELECT ${select} FROM ${table} WHERE id = ?${kindFilter}`, id, ...kindArgs)
        .toArray()[0];
      return row && toItem(mapping, row);
    },

    insert(item) {
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
        ...kindArgs,
        ...fields.map((field) => bind(item.fields[field] ?? null)),
      );
    },

    update(item) {
      const assignments = [
        'rev = ?',
        'updated_at = ?',
        ...fieldColumns.map((column) => `${column} = ?`),
      ];
      sql.exec(
        `UPDATE ${table} SET ${assignments.join(', ')} WHERE id = ?${kindFilter}`,
        item.rev,
        item.updatedAt,
        ...fields.map((field) => bind(item.fields[field] ?? null)),
        item.id,
        ...kindArgs,
      );
    },

    count(excluding) {
      let where = discriminator ? `${discriminator.column} = ?` : '1 = 1';
      const args: SqlStorageValue[] = [...kindArgs];
      if (excluding) {
        const column = columns[excluding.field];
        if (!column)
          throw new Error(`The ${mapping.entity} mapping has no field “${excluding.field}”.`);
        where += ` AND ${column} IS NOT ?`;
        args.push(bind(excluding.value));
      }
      return sql
        .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`, ...args)
        .one().count;
    },
  };
}

function toItem(mapping: TableMapping, row: Record<string, SqlStorageValue>): EntityItem {
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
