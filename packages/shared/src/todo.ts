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
