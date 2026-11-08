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
  type Writes,
} from './change';
import { VERSION_LIMIT, oldestKeptVersion, type VersionFields } from './versions';

/** Rule violations a To-Do change can report. */
export type ViolationCode =
  | RuleViolationCode
  | 'invalid_title'
  | 'invalid_notes'
  | 'invalid_due_date'
  | 'not_found'
  | 'already_exists'
  | 'todo_limit_reached';

/** Longest To-Do title accepted, in characters (Unicode code points). */
export const TITLE_MAX_LENGTH = 500;

/** Longest To-Do notes accepted, in characters (Unicode code points). */
export const NOTES_MAX_LENGTH = 2000;

/** Most To-Dos one board can hold, in any state. Becomes the per-user limit once sign-in exists. */
export const LIMIT = 10_000;

export const STATES = ['new', 'active', 'pending', 'done'] as const;

export type State = (typeof STATES)[number];

export const CHANGES = ['create', 'edit'] as const;

export type ChangeKind = (typeof CHANGES)[number];

/** One version of a To-Do: its data after a change, and what, when and who changed it. */
export interface Entity extends EntityBase, VersionFields<ChangeKind, Field> {
  kind: 'todoVersion';
  /** Derived from the To-Do and the version number: see versionId. */
  id: string;
  todoId: string;
  title: string;
  /** Empty when there are none. */
  notes: string;
  /** Calendar date as YYYY-MM-DD. */
  dueDate: string | null;
  state: State;
}

/** A To-Do's own data, as one version holds it. */
export type Data = Pick<Entity, 'title' | 'notes' | 'dueDate' | 'state'>;

export type Field = keyof Data;

/**
 * An edit never carries state: state follows from a To-Do's Tasks or from explicit
 * actions (done, abandon, reopen), whichever side runs these rules. parseEdit enforces it.
 */
export type Change =
  | { op: 'create'; todoId: string; fields: Data }
  | { op: 'edit'; todoId: string; fields: Partial<Data> };

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

/** Trims the notes and checks they are within NOTES_MAX_LENGTH. */
export function checkNotes(input: unknown): Checked<string, ViolationCode> {
  if (typeof input !== 'string') return violation('invalid_notes', 'Notes must be text.');
  const notes = input.trim();
  if ([...notes].length > NOTES_MAX_LENGTH) {
    return violation('invalid_notes', `Notes must be at most ${NOTES_MAX_LENGTH} characters.`);
  }
  return { ok: true, value: notes };
}

/** Accepts null (no due date) or a real calendar date written YYYY-MM-DD. */
export function checkDueDate(input: unknown): Checked<string | null, ViolationCode> {
  if (input === null) return { ok: true, value: null };
  const invalid = violation('invalid_due_date', 'Due date must be a date as YYYY-MM-DD, or null.');
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return invalid;
  const [year, month, day] = input.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? { ok: true, value: input } : invalid;
}

/** Reads a create request for the To-Do `todoId`: a title, optional notes and an optional due date. */
export function parseCreate(
  input: unknown,
  todoId: string,
): Checked<Change & { op: 'create' }, ViolationCode> {
  if (!isObject(input)) return violation('invalid_change', 'Body must be a JSON object.');
  const title = checkTitle(input.title);
  if (!title.ok) return violation('invalid_title', title.message);
  const notes = 'notes' in input ? checkNotes(input.notes) : { ok: true as const, value: '' };
  if (!notes.ok) return notes;
  const dueDate =
    'dueDate' in input ? checkDueDate(input.dueDate) : { ok: true as const, value: null };
  if (!dueDate.ok) return dueDate;
  return {
    ok: true,
    value: {
      op: 'create',
      todoId,
      fields: { title: title.title, notes: notes.value, dueDate: dueDate.value, state: 'new' },
    },
  };
}

/** Reads an edit request for the To-Do `todoId`: any non-empty subset of title, notes and due date. */
export function parseEdit(
  input: unknown,
  todoId: string,
): Checked<Change & { op: 'edit' }, ViolationCode> {
  if (!isObject(input)) return violation('invalid_change', 'Body must be a JSON object.');
  const fields: Partial<Data> = {};
  if ('title' in input) {
    const title = checkTitle(input.title);
    if (!title.ok) return violation('invalid_title', title.message);
    fields.title = title.title;
  }
  if ('notes' in input) {
    const notes = checkNotes(input.notes);
    if (!notes.ok) return notes;
    fields.notes = notes.value;
  }
  if ('dueDate' in input) {
    const dueDate = checkDueDate(input.dueDate);
    if (!dueDate.ok) return dueDate;
    fields.dueDate = dueDate.value;
  }
  if (Object.keys(fields).length === 0) {
    return violation('invalid_change', 'Change at least one of title, notes or dueDate.');
  }
  return { ok: true, value: { op: 'edit', todoId, fields } };
}

/** What apply needs to know: the To-Do's newest version and, for a create, how many exist. */
export interface Context {
  current: Entity | null;
  count: number | null;
}

/** The newest version of a To-Do, or null if it does not exist. */
export async function newest(store: Store<Entity>, todoId: string): Promise<Entity | null> {
  const [version] = await store.find('todoVersion', {
    where: { todoId },
    orderBy: { field: 'version', desc: true },
    limit: 1,
  });
  return version ?? null;
}

export async function load(store: Store<Entity>, change: Change): Promise<Context> {
  return {
    current: await newest(store, change.todoId),
    count: change.op === 'create' ? await store.count('todoVersion', 'todoId') : null,
  };
}

/**
 * Decides what a change writes: the To-Do's next version, and the versions that fall
 * past VERSION_LIMIT. Nothing means it changes nothing.
 */
export function apply(
  { current, count }: Context,
  change: Change,
  meta: Meta,
  now: number,
): Checked<Writes<Entity>, ViolationCode> {
  if (change.op === 'create') {
    if (current) return violation('already_exists', 'This To-Do already exists.');
    if ((count ?? 0) >= LIMIT) return violation('todo_limit_reached', 'This board is full.');
  } else if (!current) {
    return violation('not_found', 'No such To-Do.');
  }
  const changedFields =
    change.op === 'create'
      ? (Object.keys(change.fields) as Field[])
      : (Object.keys(change.fields) as Field[]).filter(
          (field) => change.fields[field] !== current?.[field],
        );
  if (changedFields.length === 0) return { ok: true, value: { put: [], delete: [] } };

  const version = (current?.version ?? 0) + 1;
  const next: Entity = {
    kind: 'todoVersion',
    id: versionId(change.todoId, version),
    todoId: change.todoId,
    version,
    createdAt: current?.createdAt ?? now,
    change: change.op,
    changedFields,
    changedAt: now,
    ...meta,
    title: current?.title ?? '',
    notes: current?.notes ?? '',
    dueDate: current?.dueDate ?? null,
    state: current?.state ?? 'new',
    ...change.fields,
  };
  const pruned =
    version > VERSION_LIMIT
      ? [
          {
            kind: 'todoVersion' as const,
            where: { todoId: change.todoId },
            before: { field: 'version' as const, value: oldestKeptVersion(version) },
          },
        ]
      : [];
  return { ok: true, value: { put: [next], delete: pruned } };
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
  ): Checked<Writes<Entity>, ViolationCode> {
    return apply(context, change, meta, now);
  }
}

export const entityType = new TodoType();
