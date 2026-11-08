import type * as Todos from './todo';

export * as Todos from './todo';
export {
  write,
  type Checked,
  type EntityBase,
  type Kind,
  type RuleViolationCode,
  type Store,
} from './change';

/** A To-Do as the API returns it. */
export interface Todo {
  id: string;
  title: string;
  state: Todos.State;
  createdAt: string;
}

export interface CreateTodoRequest {
  title: string;
}

export type ApiErrorCode = Todos.ViolationCode | 'invalid_json' | 'payload_too_large' | 'not_found';

export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}
