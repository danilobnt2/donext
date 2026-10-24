/**
 * How each kind of synced data is kept on this device: an object store named after the kind,
 * with flat records (`id`, `rev`, `createdAt`, `updatedAt`, one property per field, and the
 * `seq` sync stamps on every row). It mirrors how the server keeps the same kind. A kind that
 * syncs needs an entry here and a migration that creates its store; tests check both.
 */
export interface StoreMapping {
  entity: string;
  /** Every field of the kind’s schema, and nothing else. */
  fields: string[];
  /** Fields to index, for the lookups the app makes on them. */
  indexes: string[];
}

/** Properties every record has, so no field can use these names. `seq` is sync's. */
export const BASE_PROPERTIES = ['id', 'rev', 'createdAt', 'updatedAt', 'seq'];

export const STORES: Readonly<Record<string, StoreMapping>> = {
  todo: { entity: 'todo', fields: ['title', 'state'], indexes: ['state'] },
};
