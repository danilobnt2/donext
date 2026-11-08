/**
 * Every kind of entity a user's data holds, on every platform. Tasks join this list when
 * they arrive; the types below follow from it.
 */

import type { EntityType } from './change';
import * as Todos from './todo';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any EntityType, whatever its types
type AnyEntityType = EntityType<any, any, any, any>;

/** Lists the kinds of entity a user's data holds, keyed by kind. */
function defineEntities<const X extends readonly AnyEntityType[]>(
  ...types: X
): { [T in X[number] as T['kind']]: T } {
  return Object.fromEntries(types.map((type) => [type.kind, type])) as never;
}

export const entities = defineEntities(Todos.entityType);

type Entities = typeof entities;
export type Kind = keyof Entities;
export type EntityOf<K extends Kind> = Entities[K]['types']['entity'];
export type ChangeOf<K extends Kind> = Entities[K]['types']['change'];
export type CodeOf<K extends Kind> = Entities[K]['types']['code'];
export type Entity = EntityOf<Kind>;
