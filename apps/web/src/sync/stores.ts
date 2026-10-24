/**
 * How each kind of synced data is kept on this device: an object store of its own, named
 * after the kind, whose records are flat (`id`, `rev`, `createdAt`, `updatedAt` and one
 * property per field). It mirrors how the server keeps the same kind, so the two can be
 * read side by side. A kind that syncs needs an entry here and a migration that creates its
 * store; tests check both.
 */
export interface StoreMapping {
  entity: string;
  /** Every field of the kind’s schema, and nothing else. */
  fields: string[];
  /** Fields to index, for the lookups the app makes on them. */
  indexes: string[];
}

/** Properties every record has, so no field can use these names. */
export const BASE_PROPERTIES = ['id', 'rev', 'createdAt', 'updatedAt'];

export const STORES: Readonly<Record<string, StoreMapping>> = {
  todo: { entity: 'todo', fields: ['title', 'state'], indexes: ['state'] },
};
