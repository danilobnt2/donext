import type { TodoState } from './todo';

export * from './todo';

export interface Todo {
  id: string;
  title: string;
  state: TodoState;
  createdAt: string;
}

export interface CreateTodoRequest {
  title: string;
}

export type ApiErrorCode =
  'invalid_json' | 'invalid_title' | 'payload_too_large' | 'todo_limit_reached' | 'not_found';

export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}
