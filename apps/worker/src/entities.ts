import type { Entity } from '@donext/shared';
import { mappingsFor } from './db-store';
import { workItems } from './db/schema';

/**
 * Where each kind of entity is stored. The kinds and their rules are listed in
 * @donext/shared; this only pairs each with its table, and fails to compile if a table
 * and its entity differ.
 */
export const mappings = mappingsFor<Entity>()({
  todo: { table: workItems },
});
