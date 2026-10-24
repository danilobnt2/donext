import type { CreateResult, MutationResult, SyncEngine } from './client';
import { toTodo, type Todo } from './todo';

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

/** Deletes every To-Do, on every device. */
export function deleteAllTodos(engine: SyncEngine): Promise<number> {
  return engine.delete(engine.items('todo').map((item) => item.id));
}
