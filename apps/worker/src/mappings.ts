import type { TableMapping } from './repository';

/**
 * Where each kind of synced data lives. A kind that syncs needs an entry here, and the table
 * and columns it names must exist; both are checked by tests.
 */
export const MAPPINGS: Readonly<Record<string, TableMapping>> = {
  todo: {
    entity: 'todo',
    table: 'work_items',
    discriminator: { column: 'type', value: 'todo' },
    columns: { title: 'title', state: 'state' },
  },
};
