/**
 * What every entity has in common, whatever its kind. Each kind (To-Dos now, Tasks later)
 * is an EntityType: its rules and its SQLite table. Each platform (the Durable Object
 * now, devices later) supplies its storage as a Store. write() joins the two.
 */

import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { customType } from 'drizzle-orm/sqlite-core';

/** Rule violations any kind of entity can report. Each kind adds its own codes. */
export type RuleViolationCode = 'invalid_change';

/** A parsed value, or the rule it broke. `Code` is the codes that may be reported. */
export type Checked<T, Code extends string = RuleViolationCode> =
  { ok: true; value: T } | { ok: false; code: Code; message: string };

/** What every stored entity has, whatever its kind. */
export interface EntityBase {
  /** The kind of entity, such as 'todo'. */
  kind: string;
  id: string;
}

/** A table that holds one kind of entity: its key is exposed as `id`. */
export type EntityTable = SQLiteTable & { id: SQLiteColumn };

/**
 * Storage for entities, implemented once per platform. Between write()'s load and its
 * commit no other write may run; each Store guarantees it.
 */
export interface Store<E extends EntityBase> {
  get<K extends E['kind']>(kind: K, id: string): Promise<Extract<E, { kind: K }> | null>;
  count(kind: E['kind']): Promise<number>;
  /** Writes every entity as given, all or nothing. */
  commit(entities: E[]): Promise<void>;
}

/**
 * One kind of entity: where it is stored, and the rules for changing it. load reads what
 * the rules need; apply decides, as a pure function, which entities to write. A change can
 * touch several entities, of any kind; none means nothing changed. Entities themselves
 * stay plain data, so they cross JSON, SQL and devices unchanged.
 */
export abstract class EntityType<
  E extends EntityBase,
  C,
  Code extends string,
  Context,
  T extends EntityTable = EntityTable,
> {
  abstract readonly kind: E['kind'];
  /** The table, whose rows are the entities without `kind`. */
  abstract readonly table: T;
  abstract load(store: Store<E>, change: C): Promise<Context>;
  /** `now` is the clock of whoever runs the rules, in Unix milliseconds. */
  abstract apply(context: Context, change: C, now: number): Checked<E[], Code>;
  /** The types an EntityType works with, for the compiler only. */
  declare readonly types: { entity: E; change: C; code: Code };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any EntityType, whatever its types
type AnyEntityType = EntityType<any, any, any, any, EntityTable>;

/** Applies a change and commits the entities it produces. */
export async function write<E extends EntityBase, C, Code extends string, Context>(
  type: EntityType<E, C, Code, Context>,
  store: Store<E>,
  change: C,
  now: number,
): Promise<Checked<E[], Code>> {
  const result = type.apply(await type.load(store, change), change, now);
  if (result.ok && result.value.length > 0) await store.commit(result.value);
  return result;
}

type Flat<T> = { [K in keyof T]: T[K] };
type Same<A, B> =
  (<X>() => X extends Flat<A> ? 1 : 2) extends <X>() => X extends Flat<B> ? 1 : 2 ? true : false;

/** The EntityType as given, or an error message if its table and its entity differ. */
type Matching<X extends AnyEntityType> =
  Same<
    Omit<X['table']['$inferSelect'], 'kind'> & { kind: X['kind'] },
    X['types']['entity']
  > extends true
    ? X
    : `The ${X['kind']} table does not match its entity`;

/**
 * Lists the kinds of entity a user's data holds, keyed by kind. Fails to compile if any
 * table and its entity drift apart, so rows need no mapping code.
 */
export function defineEntities<const X extends readonly AnyEntityType[]>(
  ...types: { [I in keyof X]: Matching<X[I]> }
): { [T in X[number] as T['kind']]: T } {
  const list = types as readonly AnyEntityType[];
  return Object.fromEntries(list.map((type) => [type.kind, type])) as never;
}

/** A time stored as ISO 8601 text, read and written as Unix milliseconds. */
export const isoTime = customType<{ data: number; driverData: string }>({
  dataType: () => 'text',
  toDriver: (ms) => new Date(ms).toISOString(),
  fromDriver: (iso) => Date.parse(iso),
});

export function isObject(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

export function violation<Code extends string>(
  code: Code,
  message: string,
): { ok: false; code: Code; message: string } {
  return { ok: false, code, message };
}
