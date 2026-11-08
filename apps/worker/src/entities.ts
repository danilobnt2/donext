import { Todos, type Kind } from '@donext/shared';
import { mappingsFor } from './db-store';
import { workItems } from './db/schema';

/**
 * Every type of entity a user's data holds: its stored shape, the changes it accepts
 * and the rule violations they can report. Tasks join here when they arrive.
 */
export interface EntityTypes {
  todo: { entity: Todos.Entity; change: Todos.Change; code: Todos.ViolationCode };
}

export type Type = keyof EntityTypes;
export type Entity = EntityTypes[Type]['entity'];
export type EntityOf<K extends Type> = EntityTypes[K]['entity'];
export type ChangeOf<K extends Type> = EntityTypes[K]['change'];
export type CodeOf<K extends Type> = EntityTypes[K]['code'];

/** The rules each type of change runs. */
export const rules: { [K in Type]: Kind<Entity, ChangeOf<K>, CodeOf<K>, unknown> } = {
  todo: Todos.kind,
};

/** Where each type of entity is stored. Fails to compile if a table and its entity differ. */
export const mappings = mappingsFor<Entity>()({
  // To-Dos are the rows of work_items whose type is 'todo'.
  todo: { table: workItems, scope: { key: 'type', value: 'todo' } },
});
