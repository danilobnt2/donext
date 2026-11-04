/**
 * Rules for creating and changing To-Dos. Pure functions with no platform APIs, so the
 * server enforces them and devices can reuse them.
 */

/** Longest To-Do title accepted, in characters (Unicode code points). */
export const TITLE_MAX_LENGTH = 500;

/** Longest To-Do notes accepted, in characters (Unicode code points). */
export const NOTES_MAX_LENGTH = 2000;

/** Most To-Dos one board can hold. Becomes the per-user limit once sign-in exists. */
export const TODO_LIMIT = 10_000;

/** Versions kept per To-Do. Older ones are dropped first; the newest is always kept. */
export const TODO_VERSION_LIMIT = 1000;

export type TodoState = 'new' | 'active' | 'pending' | 'done';

/** What a person edits on a To-Do. */
export interface TodoFields {
  title: string;
  /** Empty when there are none. */
  notes: string;
  /** Calendar date as YYYY-MM-DD. */
  dueDate: string | null;
}

export type TodoField = keyof TodoFields;

/** A To-Do's data as one version holds it. */
export interface TodoData extends TodoFields {
  state: TodoState;
}

export type TodoChange =
  { kind: 'create'; fields: TodoFields } | { kind: 'edit'; fields: Partial<TodoFields> };

export type TodoChangeKind = TodoChange['kind'];

/** Who or what made a change. Connectors arrive with AI connectors. */
export type Actor =
  | { kind: 'device'; id: string | null }
  | { kind: 'system'; id: null }
  | { kind: 'connector'; id: string };

export type RuleViolationCode =
  'invalid_title' | 'invalid_notes' | 'invalid_due_date' | 'invalid_change' | 'invalid_device';

export type Checked<T> =
  { ok: true; value: T } | { ok: false; code: RuleViolationCode; message: string };

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
export function checkNotes(input: unknown): Checked<string> {
  if (typeof input !== 'string') return violation('invalid_notes', 'Notes must be text.');
  const notes = input.trim();
  if ([...notes].length > NOTES_MAX_LENGTH) {
    return violation('invalid_notes', `Notes must be at most ${NOTES_MAX_LENGTH} characters.`);
  }
  return { ok: true, value: notes };
}

/** Accepts null (no due date) or a real calendar date written YYYY-MM-DD. */
export function checkDueDate(input: unknown): Checked<string | null> {
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
export function parseCreate(input: unknown): Checked<TodoChange & { kind: 'create' }> {
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
      fields: { title: title.title, notes: notes.value, dueDate: dueDate.value },
    },
  };
}

/** Reads an edit request: any non-empty subset of title, notes and due date. */
export function parseEdit(input: unknown): Checked<TodoChange & { kind: 'edit' }> {
  if (!isObject(input)) return violation('invalid_change', 'Body must be a JSON object.');
  const fields: Partial<TodoFields> = {};
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
  | { ok: true; data: TodoData; changedFields: TodoField[] }
  | { ok: false; code: 'not_found' | 'already_exists'; message: string };

/**
 * Applies a change to a To-Do's current data (null if it does not exist yet). An empty
 * changedFields means nothing changed, so no new version is needed.
 */
export function applyChange(current: TodoData | null, change: TodoChange): AppliedChange {
  if (change.kind === 'create') {
    if (current)
      return { ok: false, code: 'already_exists', message: 'This To-Do already exists.' };
    return {
      ok: true,
      data: { ...change.fields, state: 'new' },
      changedFields: ['title', 'notes', 'dueDate'],
    };
  }
  if (!current) return { ok: false, code: 'not_found', message: 'No such To-Do.' };
  const changedFields = (Object.keys(change.fields) as TodoField[]).filter(
    (field) => change.fields[field] !== current[field],
  );
  return { ok: true, data: { ...current, ...change.fields }, changedFields };
}

/** Lowest version number to keep once `newest` is written. */
export function oldestKeptVersion(newest: number): number {
  return Math.max(1, newest - TODO_VERSION_LIMIT + 1);
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Reads the optional device id and device time of a change made on an app device. A
 * device time older or newer than the server's is accepted: offline edits arrive late.
 */
export function parseDeviceMeta(
  input: unknown,
): Checked<{ actor: Actor & { kind: 'device' }; deviceChangedAt: number | null }> {
  const body = isObject(input) ? input : {};
  let id: string | null = null;
  if ('deviceId' in body) {
    if (typeof body.deviceId !== 'string' || !ULID.test(body.deviceId)) {
      return violation('invalid_device', 'deviceId must be a ULID.');
    }
    id = body.deviceId;
  }
  let deviceChangedAt: number | null = null;
  if ('deviceChangedAt' in body) {
    const time = typeof body.deviceChangedAt === 'string' ? Date.parse(body.deviceChangedAt) : NaN;
    if (
      !Number.isFinite(time) ||
      !/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(String(body.deviceChangedAt))
    ) {
      return violation('invalid_device', 'deviceChangedAt must be an ISO 8601 time with a zone.');
    }
    deviceChangedAt = time;
  }
  return { ok: true, value: { actor: { kind: 'device', id }, deviceChangedAt } };
}

function isObject(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function violation(
  code: RuleViolationCode,
  message: string,
): { ok: false; code: RuleViolationCode; message: string } {
  return { ok: false, code, message };
}
