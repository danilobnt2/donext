import type { SyncEngine } from './client';
import { toTodo, type Todo } from './todo';
import type { CreateResult, MutationResult } from './client';

/** To-Dos, as the app uses them, on top of the generic sync engine. */

export function listTodos(engine: SyncEngine): Todo[] {
  return engine.items('todo').map(toTodo);
}

export function createTodo(engine: SyncEngine, title: string): Promise<CreateResult> {
  return engine.create('todo', { title });
}

export function renameTodo(engine: SyncEngine, id: string, title: string): Promise<MutationResult> {
  return engine.update(id, { title });
}

/** Hides the To-Dos from every device. Their history is kept. */
export function abandonTodos(engine: SyncEngine, ids: readonly string[]): Promise<number> {
  return engine.updateMany(ids, { state: 'abandoned' });
}

export function abandonAllTodos(engine: SyncEngine): Promise<number> {
  return abandonTodos(
    engine,
    engine.items('todo').map((item) => item.id),
  );
}
