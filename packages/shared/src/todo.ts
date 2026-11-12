/**
 * Rules for creating and changing To-Dos: pure functions with no platform APIs, so every
 * platform that holds the user's data runs the same ones. A To-Do is kept as To-Do
 * versions, an entity type like any other: each change appends one, and the newest is the
 * To-Do's current state. Import it as the `Todos` namespace; `entityType` is what write()
 * and defineEntities() take.
 */

import {
  EntityType,
  isObject,
  violation,
  type Checked,
  type EntityBase,
  type Meta,
  type RuleViolationCode,
  type Store,
} from './change';

/** Rule violations a To-Do change can report. */
export type ViolationCode =
  RuleViolationCode | 'invalid_title' | 'already_exists' | 'todo_limit_reached';

/** Longest To-Do title accepted, in characters (Unicode code points). */
export const TITLE_MAX_LENGTH = 500;

/** Most To-Dos one board can hold, in any state. Becomes the per-user limit once sign-in exists. */
export const LIMIT = 10_000;

export const STATES = ['new', 'active', 'pending', 'done'] as const;

export type State = (typeof STATES)[number];

export const CHANGES = ['create'] as const;

export type ChangeKind = (typeof CHANGES)[number];

/** One version of a To-Do: its data after a change, and when and who changed it. */
export interface Entity extends EntityBase, Meta {
  kind: 'todoVersion';
  /** Derived from the To-Do and the version number: see versionId. */
  id: string;
  todoId: string;
  /** The version number, starting at 1. */
  version: number;
  /** When the To-Do was created; copied into every version. */
  createdAt: number;
  change: ChangeKind;
  /** When the change was accepted, on the clock of whoever runs the rules. Unix milliseconds. */
  changedAt: number;
  title: string;
  /** Empty when there are none. */
  notes: string;
  /** Calendar date as YYYY-MM-DD. */
  dueDate: string | null;
  state: State;
}

export type Change = { op: 'create'; todoId: string; title: string };

/**
 * A version's id. Derived rather than random, so the rules stay pure and two devices
 * writing the same version of a To-Do collide instead of both being kept.
 */
export function versionId(todoId: string, version: number): string {
  return `${todoId}:${version}`;
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

/** Reads a create request for the To-Do `todoId`: a title. */
export function parseCreate(input: unknown, todoId: string): Checked<Change, ViolationCode> {
  if (!isObject(input)) return violation('invalid_change', 'Body must be a JSON object.');
  const title = checkTitle(input.title);
  if (!title.ok) return violation('invalid_title', title.message);
  return { ok: true, value: { op: 'create', todoId, title: title.title } };
}

/** What apply needs to know: whether the To-Do exists, and how many To-Dos do. */
export interface Context {
  exists: boolean;
  count: number;
}

export async function load(store: Store<Entity>, change: Change): Promise<Context> {
  const found = await store.find('todoVersion', { where: { todoId: change.todoId }, limit: 1 });
  return { exists: found.length > 0, count: await store.count('todoVersion', 'todoId') };
}

/** Decides what a change writes: a new To-Do's first version. */
export function apply(
  { exists, count }: Context,
  change: Change,
  meta: Meta,
  now: number,
): Checked<Entity[], ViolationCode> {
  if (exists) return violation('already_exists', 'This To-Do already exists.');
  if (count >= LIMIT) return violation('todo_limit_reached', 'This board is full.');
  return {
    ok: true,
    value: [
      {
        kind: 'todoVersion',
        id: versionId(change.todoId, 1),
        todoId: change.todoId,
        version: 1,
        createdAt: now,
        change: change.op,
        changedAt: now,
        ...meta,
        title: change.title,
        notes: '',
        dueDate: null,
        state: 'new',
      },
    ],
  };
}

class TodoType extends EntityType<Entity, Change, ViolationCode, Context> {
  readonly kind = 'todoVersion';

  load(store: Store<Entity>, change: Change): Promise<Context> {
    return load(store, change);
  }

  apply(
    context: Context,
    change: Change,
    meta: Meta,
    now: number,
  ): Checked<Entity[], ViolationCode> {
    return apply(context, change, meta, now);
  }
}

export const entityType = new TodoType();
