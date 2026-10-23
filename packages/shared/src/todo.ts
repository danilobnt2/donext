import type { EntityItem, EntitySchema } from './entity';

/** Longest To-Do title accepted, in characters (Unicode code points). */
export const TITLE_MAX_LENGTH = 500;

/** Most To-Dos one board can hold. Becomes the per-user limit once sign-in exists. */
export const TODO_LIMIT = 10_000;

/** Abandoned is a hidden end state: the To-Do leaves the board but keeps its history. */
export type TodoState = 'new' | 'active' | 'pending' | 'done' | 'abandoned';

export interface Todo {
  id: string;
  title: string;
  state: TodoState;
  /** Number of the latest revision; 1 for a new To-Do. */
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export type ApiErrorCode = 'invalid_json' | 'invalid_request' | 'payload_too_large' | 'not_found';

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

const TODO_STATES: readonly TodoState[] = ['new', 'active', 'pending', 'done', 'abandoned'];

/** What a To-Do may contain and who may change it. The server also writes `state` itself. */
export const todoSchema: EntitySchema = {
  name: 'todo',
  label: 'To-Do',
  fields: {
    title: {
      create: 'required',
      parse(value) {
        const check = checkTitle(value);
        return check.ok ? { ok: true, value: check.title } : check;
      },
    },
    state: {
      create: 'forbidden',
      default: 'new',
      deviceValues: ['abandoned'],
      parse: (value) =>
        TODO_STATES.includes(value as TodoState)
          ? { ok: true, value: value as TodoState }
          : { ok: false, message: 'Unknown state.' },
    },
  },
  terminal: {
    field: 'state',
    value: 'abandoned',
    message: 'This To-Do was abandoned and cannot be edited.',
  },
  limit: { max: TODO_LIMIT, message: 'This board is full.' },
};

export function toTodo(item: EntityItem): Todo {
  return {
    id: item.id,
    title: String(item.fields.title),
    state: item.fields.state as TodoState,
    rev: item.rev,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
