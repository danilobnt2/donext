/**
 * Rules for creating and changing To-Dos: pure functions with no platform APIs, so every
 * platform that holds the user's data runs the same ones. Import it as the `Todos`
 * namespace; `kind` is what write() takes.
 */

import {
  isObject,
  violation,
  type Checked,
  type EntityBase,
  type Kind,
  type RuleViolationCode,
  type Store,
} from './change';

/** Rule violations a To-Do change can report. */
export type ViolationCode =
  RuleViolationCode | 'invalid_title' | 'already_exists' | 'todo_limit_reached';

/** Longest To-Do title accepted, in characters (Unicode code points). */
export const TITLE_MAX_LENGTH = 500;

/** Most To-Dos one board can hold. Becomes the per-user limit once sign-in exists. */
export const LIMIT = 10_000;

export const STATES = ['new', 'active', 'pending', 'done'] as const;

export type State = (typeof STATES)[number];

/** A To-Do as it is stored. Times are Unix milliseconds. */
export interface Entity extends EntityBase {
  kind: 'todo';
  title: string;
  state: State;
  /** Counts the writes to this To-Do, starting at 1. */
  rev: number;
  createdAt: number;
  updatedAt: number;
}

export type Change = { op: 'create'; id: string; title: string };

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

/** Reads a create request for the To-Do `id`: a title. */
export function parseCreate(input: unknown, id: string): Checked<Change, ViolationCode> {
  if (!isObject(input)) return violation('invalid_change', 'Body must be a JSON object.');
  const title = checkTitle(input.title);
  if (!title.ok) return violation('invalid_title', title.message);
  return { ok: true, value: { op: 'create', id, title: title.title } };
}

/** What apply needs to know: the To-Do as stored, and how many exist. */
export interface Context {
  current: Entity | null;
  count: number;
}

export async function load(store: Store<Entity>, change: Change): Promise<Context> {
  return { current: await store.get('todo', change.id), count: await store.count('todo') };
}

/** Decides which entities a change writes. */
export function apply(
  { current, count }: Context,
  change: Change,
  now: number,
): Checked<Entity[], ViolationCode> {
  if (current) return violation('already_exists', 'This To-Do already exists.');
  if (count >= LIMIT) return violation('todo_limit_reached', 'This board is full.');
  return {
    ok: true,
    value: [
      {
        kind: 'todo',
        id: change.id,
        title: change.title,
        state: 'new',
        rev: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

export const kind: Kind<Entity, Change, ViolationCode, Context> = { load, apply };
