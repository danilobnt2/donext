/**
 * Rules for creating and changing To-Dos: pure functions with no platform APIs, so every
 * platform that holds the user's data runs the same ones. Import it as the `Todos`
 * namespace; `entityType` is what write() and defineEntities() take.
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
export interface Entity extends EntityBase {
  kind: 'todo';
  change: ChangeKind;
  changedFields: Field[];
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
  { op: 'create'; id: string; fields: Data } | { op: 'edit'; id: string; fields: Partial<Data> };

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

/** Reads a create request for the To-Do `id`: a title, optional notes and an optional due date. */
export function parseCreate(
  input: unknown,
  id: string,
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
      id,
      fields: { title: title.title, notes: notes.value, dueDate: dueDate.value, state: 'new' },
    },
  };
}

/** Reads an edit request for the To-Do `id`: any non-empty subset of title, notes and due date. */
export function parseEdit(
  input: unknown,
  id: string,
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
  return { ok: true, value: { op: 'edit', id, fields } };
}

/** What apply needs to know: the To-Do's newest version and, for a create, how many exist. */
export interface Context {
  current: Entity | null;
  count: number | null;
}

export async function load(store: Store<Entity>, change: Change): Promise<Context> {
  return {
    current: await store.get('todo', change.id),
    count: change.op === 'create' ? await store.count('todo') : null,
  };
}

/** Decides which versions a change appends. None means it changes nothing. */
export function apply(
  { current, count }: Context,
  change: Change,
  meta: Meta,
  now: number,
): Checked<Entity[], ViolationCode> {
  const stamp = {
    kind: 'todo',
    id: change.id,
    change: change.op,
    changedAt: now,
    ...meta,
  } as const;
  if (change.op === 'create') {
    if (current) return violation('already_exists', 'This To-Do already exists.');
    if ((count ?? 0) >= LIMIT) return violation('todo_limit_reached', 'This board is full.');
    const changedFields = Object.keys(change.fields) as Field[];
    return {
      ok: true,
      value: [{ ...stamp, version: 1, createdAt: now, changedFields, ...change.fields }],
    };
  }
  if (!current) return violation('not_found', 'No such To-Do.');
  const changedFields = (Object.keys(change.fields) as Field[]).filter(
    (field) => change.fields[field] !== current[field],
  );
  if (changedFields.length === 0) return { ok: true, value: [] };
  return {
    ok: true,
    value: [
      {
        ...stamp,
        version: current.version + 1,
        createdAt: current.createdAt,
        changedFields,
        title: current.title,
        notes: current.notes,
        dueDate: current.dueDate,
        state: current.state,
        ...change.fields,
      },
    ],
  };
}

class TodoType extends EntityType<Entity, Change, ViolationCode, Context> {
  readonly kind = 'todo';

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
