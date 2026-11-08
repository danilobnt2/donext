import { Todos, type Kind } from '@donext/shared';
import type { Mappings } from './db-store';
import { todos } from './db/todos';

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

/** Where each type of entity is stored. */
export const mappings: Mappings<Entity> = { todo: todos };
