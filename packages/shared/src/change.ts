/**
 * What every change has in common, whatever kind of entity it touches: how a broken rule
 * is reported, and how a change is written. Each kind (To-Dos now, Tasks later) supplies
 * its rules as a Kind; each platform (the Durable Object now, devices later) supplies its
 * storage as a Store; write() joins the two.
 */

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
 * The rules for one kind of change. load reads what the rules need; apply decides, as a
 * pure function, which entities to write. A change can touch several entities, of
 * any kind; none means nothing changed.
 */
export interface Kind<E extends EntityBase, C, Code extends string, Context> {
  load(store: Store<E>, change: C): Promise<Context>;
  /** `now` is the clock of whoever runs the rules, in Unix milliseconds. */
  apply(context: Context, change: C, now: number): Checked<E[], Code>;
}

/** Applies a change and commits the entities it produces. */
export async function write<E extends EntityBase, C, Code extends string, Context>(
  kind: Kind<E, C, Code, Context>,
  store: Store<E>,
  change: C,
  now: number,
): Promise<Checked<E[], Code>> {
  const result = kind.apply(await kind.load(store, change), change, now);
  if (result.ok && result.value.length > 0) await store.commit(result.value);
  return result;
}

export function isObject(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

export function violation<Code extends string>(
  code: Code,
  message: string,
): { ok: false; code: Code; message: string } {
  return { ok: false, code, message };
}
