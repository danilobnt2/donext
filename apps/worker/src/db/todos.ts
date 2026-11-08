import type { Todos } from '@donext/shared';
import { eq } from 'drizzle-orm';
import type { Mapping } from '../db-store';
import { workItems } from './schema';

/** To-Dos are the rows of `work_items` whose type is 'todo'. */
export const todos: Mapping<Todos.Item, typeof workItems> = {
  table: workItems,
  id: workItems.id,
  scope: eq(workItems.type, 'todo'),
  toRow: (todo) => ({
    id: todo.id,
    type: 'todo',
    title: todo.title,
    state: todo.state,
    rev: todo.rev,
    createdAt: new Date(todo.createdAt).toISOString(),
    updatedAt: new Date(todo.updatedAt).toISOString(),
  }),
  fromRow: (row) => ({
    kind: 'todo',
    id: row.id,
    title: row.title,
    state: row.state as Todos.State,
    rev: row.rev,
    createdAt: Date.parse(row.createdAt),
    updatedAt: Date.parse(row.updatedAt),
  }),
};
