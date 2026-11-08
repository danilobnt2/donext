/**
 * Rules for creating and changing To-Dos. Pure functions with no platform APIs, so the
 * server enforces them and devices can reuse them. Import it as the `Todos` namespace.
 */

import { isObject, violation, type Checked, type RuleViolationCode } from './change';

/** Rule violations a To-Do change can report. */
export type ViolationCode =
  RuleViolationCode | 'invalid_title' | 'invalid_notes' | 'invalid_due_date';

/** Longest To-Do title accepted, in characters (Unicode code points). */
export const TITLE_MAX_LENGTH = 500;

/** Longest To-Do notes accepted, in characters (Unicode code points). */
export const NOTES_MAX_LENGTH = 2000;

/** Most To-Dos one board can hold. Becomes the per-user limit once sign-in exists. */
export const LIMIT = 10_000;

/** Versions kept per To-Do. Older ones are dropped first; the newest is always kept. */
export const VERSION_LIMIT = 1000;

export type State = 'new' | 'active' | 'pending' | 'done';

/** A To-Do's data as one version holds it. */
export interface Data {
  title: string;
  /** Empty when there are none. */
  notes: string;
  /** Calendar date as YYYY-MM-DD. */
  dueDate: string | null;
  state: State;
}

export type Field = keyof Data;

/**
 * An edit never carries state: state follows from a To-Do's Tasks or from explicit
 * actions (done, abandon, reopen), whichever side runs these rules. parseEdit enforces it.
 */
export type Change = { kind: 'create'; fields: Data } | { kind: 'edit'; fields: Partial<Data> };

export type ChangeKind = Change['kind'];

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

/** Reads a create request: a title, optional notes and an optional due date. */
export function parseCreate(input: unknown): Checked<Change & { kind: 'create' }, ViolationCode> {
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
      kind: 'create',
      fields: { title: title.title, notes: notes.value, dueDate: dueDate.value, state: 'new' },
    },
  };
}

/** Reads an edit request: any non-empty subset of title, notes and due date. */
export function parseEdit(input: unknown): Checked<Change & { kind: 'edit' }, ViolationCode> {
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
  return { ok: true, value: { kind: 'edit', fields } };
}

export type AppliedChange =
  | { ok: true; data: Data; changedFields: Field[] }
  | { ok: false; code: 'not_found' | 'already_exists'; message: string };

/**
 * Applies a change to a To-Do's current data (null if it does not exist yet). An empty
 * changedFields means nothing changed, so no new version is needed.
 */
export function applyChange(current: Data | null, change: Change): AppliedChange {
  if (change.kind === 'create') {
    if (current)
      return { ok: false, code: 'already_exists', message: 'This To-Do already exists.' };
    return {
      ok: true,
      data: change.fields,
      changedFields: Object.keys(change.fields) as Field[],
    };
  }
  if (!current) return { ok: false, code: 'not_found', message: 'No such To-Do.' };
  const changedFields = (Object.keys(change.fields) as Field[]).filter(
    (field) => change.fields[field] !== current[field],
  );
  return { ok: true, data: { ...current, ...change.fields }, changedFields };
}

/** Lowest version number to keep once `newest` is written. */
export function oldestKeptVersion(newest: number): number {
  return Math.max(1, newest - VERSION_LIMIT + 1);
}
