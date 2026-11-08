import type { Actor, RuleViolationCode } from './change';
import type * as Todos from './todo';

export * as Todos from './todo';
export { parseDeviceMeta, type Actor, type Checked, type RuleViolationCode } from './change';

/** A To-Do as the API returns it: the data of its newest version. */
export interface Todo {
  id: string;
  title: string;
  notes: string;
  dueDate: string | null;
  state: Todos.State;
  /** Number of the newest version. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** One version of a To-Do: its data after a change, and what, when and who changed it. */
export interface TodoVersion {
  version: number;
  change: Todos.ChangeKind;
  changedFields: Todos.Field[];
  /** Server time the change was accepted. */
  changedAt: string;
  /** Device time of the change, when the device sent one. */
  deviceChangedAt: string | null;
  actor: Actor;
  todo: Todos.Data;
}

/** Optional on every write from an app device. */
export interface DeviceMeta {
  deviceId?: string;
  deviceChangedAt?: string;
}

export interface CreateTodoRequest extends DeviceMeta {
  title: string;
  notes?: string;
  dueDate?: string | null;
}

export interface EditTodoRequest extends DeviceMeta {
  title?: string;
  notes?: string;
  dueDate?: string | null;
}

export type ApiErrorCode =
  | RuleViolationCode
  | 'invalid_json'
  | 'invalid_cursor'
  | 'payload_too_large'
  | 'todo_limit_reached'
  | 'not_found';

export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}
