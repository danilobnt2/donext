/**
 * Every kind of entity a user's data holds, on every platform. Tasks join this list when
 * they arrive; the types below follow from it.
 */

import { defineEntities } from './change';
import * as Todos from './todo';

export const entities = defineEntities(Todos.entityType);

type Entities = typeof entities;
export type Kind = keyof Entities;
export type EntityOf<K extends Kind> = Entities[K]['types']['entity'];
export type ChangeOf<K extends Kind> = Entities[K]['types']['change'];
export type CodeOf<K extends Kind> = Entities[K]['types']['code'];
export type Entity = EntityOf<Kind>;
