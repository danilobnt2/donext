import type { EntityItem, EntitySchema } from './entity';

/** Longest To-Do title accepted, in characters (Unicode code points). */
export const TITLE_MAX_LENGTH = 500;

/** Most To-Dos one board can hold. Becomes the per-user limit once sign-in exists. */
export const TODO_LIMIT = 10_000;

export type TodoState = 'new' | 'active' | 'pending' | 'done';

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

export type TitleCheck = { ok: true; title: string } | { ok: false; message: string };

/** Trims the title and checks it is non-empty and within TITLE_MAX_LENGTH. */
export function checkTitle(input: unknown): TitleCheck {
  if (typeof input !== 'string') return { ok: false, message: 'Title must be text.' };
  const title = input.trim();
  if (title.length === 0) return { ok: false, message: 'Title is required.' };
  if ([...title].length > TITLE_MAX_LENGTH) {
    return { ok: false, message: `Title must be at most ${TITLE_MAX_LENGTH} characters.` };
  }
  return { ok: true, title };
}

const TODO_STATES: readonly TodoState[] = ['new', 'active', 'pending', 'done'];

/** What a To-Do may contain. Its state is the server's to work out, from its Tasks. */
export const todoSchema: EntitySchema = {
  name: 'todo',
  label: 'To-Do',
  fields: {
    title: {
      required: true,
      parse(value) {
        const check = checkTitle(value);
        return check.ok ? { ok: true, value: check.title } : check;
      },
    },
    state: {
      default: 'new',
      writable: 'never',
      parse: (value) =>
        TODO_STATES.includes(value as TodoState)
          ? { ok: true, value: value as TodoState }
          : { ok: false, message: 'Unknown state.' },
    },
  },
  limit: { max: TODO_LIMIT, message: 'This board is full.' },
};

export function toTodo(item: EntityItem): Todo {
  return {
    id: item.id,
    title: String(item.fields.title),
    state: item.fields.state as TodoState,
    createdAt: item.createdAt,
  };
}
