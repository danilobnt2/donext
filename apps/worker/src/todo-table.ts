import type { Todos } from '@donext/shared';
import type { SqlStore, Table } from './sql-store';

/** How To-Do versions map to `todo_versions`. */
export const todoTable: Table<Todos.Version> = {
  kind: 'todo',
  name: 'todo_versions',
  idColumn: 'todo_id',
  dataToRow: (data) => ({
    title: data.title,
    notes: data.notes,
    due_date: data.dueDate,
    state: data.state,
  }),
  dataFromRow: (row) => ({
    title: row.title as string,
    notes: row.notes as string,
    dueDate: row.due_date as string | null,
    state: row.state as Todos.State,
  }),
};

/** The To-Do board: every To-Do's newest version except abandoned ones, newest first. */
export function todoBoard(store: SqlStore<Todos.Version>): Todos.Version[] {
  // The table already allows 'abandoned'; Todos.State gains it with the abandon action.
  return store.current('todo').filter((todo) => (todo.data.state as string) !== 'abandoned');
}
