/**
 * To-Dos: their table and their rules, as pure code with no platform APIs, so every
 * platform that holds the user's data stores and changes them the same way. Import it as
 * the `Todos` namespace; `entityType` is what write() and defineEntities() take.
 */

import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  EntityType,
  isObject,
  isoTime,
  violation,
  type Checked,
  type EntityBase,
  type RuleViolationCode,
  type Store,
} from './entity';

/** Rule violations a To-Do change can report. */
export type ViolationCode =
  RuleViolationCode | 'invalid_title' | 'already_exists' | 'todo_limit_reached';

/** Longest To-Do title accepted, in characters (Unicode code points). */
export const TITLE_MAX_LENGTH = 500;

/** Most To-Dos one board can hold. Becomes the per-user limit once sign-in exists. */
export const LIMIT = 10_000;

export const STATES = ['new', 'active', 'pending', 'done'] as const;

export type State = (typeof STATES)[number];

/**
 * Where To-Dos are stored: as work items of type 'todo'. After changing it, run
 * `pnpm --filter @donext/worker db:generate` and commit the migration it writes. Never
 * edit a migration that has shipped.
 */
export const table = sqliteTable(
  'work_items',
  {
    id: text('id').primaryKey(),
    // Only To-Dos are stored so far; the CHECK below still allows Tasks.
    type: text('type', { enum: ['todo'] }).notNull(),
    title: text('title').notNull(),
    state: text('state', { enum: STATES }).notNull(),
    rev: integer('rev').notNull(),
    createdAt: isoTime('created_at').notNull(),
    updatedAt: isoTime('updated_at').notNull(),
  },
  (table) => [check('work_items_type', sql`${table.type} IN ('todo', 'task')`)],
);

/** A To-Do as it is stored. Times are Unix milliseconds. */
export interface Entity extends EntityBase {
  kind: 'todo';
  /** To-Dos are stored as work items of this type. Goes away when they get their own table. */
  type: 'todo';
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
        type: 'todo',
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

class TodoType extends EntityType<Entity, Change, ViolationCode, Context, typeof table> {
  readonly kind = 'todo';
  readonly table = table;

  load(store: Store<Entity>, change: Change): Promise<Context> {
    return load(store, change);
  }

  apply(context: Context, change: Change, now: number): Checked<Entity[], ViolationCode> {
    return apply(context, change, now);
  }
}

export const entityType = new TodoType();
