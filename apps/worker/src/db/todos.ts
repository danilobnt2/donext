import type { Todos } from '@donext/shared';
import type { EntityOf, Mapping } from '../db-store';
import { workItems } from './schema';

/** To-Dos are the rows of `work_items` whose type is 'todo'. */
export const todos = {
  table: workItems,
  scope: { key: 'type', value: 'todo' },
} as const satisfies Mapping<typeof workItems>;

/** Fails to compile if the table and the shared To-Do drift apart. */
type Flat<T> = { [K in keyof T]: T[K] };
type Same<A, B> =
  (<T>() => T extends Flat<A> ? 1 : 2) extends <T>() => T extends Flat<B> ? 1 : 2 ? true : false;
const matches: Same<EntityOf<typeof todos, 'todo'>, Todos.Entity> = true;
void matches;
