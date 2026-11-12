/**
 * What every change has in common, whatever kind of entity it touches: who made it, how
 * a broken rule is reported, and how a change is written. Each kind is an EntityType with
 * its rules; each platform (the Durable Object now, devices later) supplies its storage
 * as a Store; write() joins the two. Nothing here knows what an entity means: To-Do
 * versions, for one, are just a kind of entity.
 */

/** Rule violations any kind of entity can report. Each kind adds its own codes. */
export type RuleViolationCode = 'invalid_change';

/** A parsed value, or the rule it broke. `Code` is the codes that may be reported. */
export type Checked<T, Code extends string = RuleViolationCode> =
  { ok: true; value: T } | { ok: false; code: Code; message: string };

/** Who made a change. Only app devices make changes so far. */
export type Actor = { kind: 'device' };

/** Who made a change and, for a device, when on its own clock (Unix milliseconds). */
export interface Meta {
  actor: Actor;
  deviceChangedAt: number | null;
}

/** What every stored entity has, whatever its kind. */
export interface EntityBase {
  /** The kind of entity, such as 'todoVersion'. */
  kind: string;
  id: string;
}

type Value = string | number | boolean | null;

/** A field of an entity whose values a Store can filter and sort on. */
export type FieldOf<E> = {
  [F in keyof E]-?: E[F] extends Value ? (F extends 'kind' ? never : F) : never;
}[keyof E] &
  string;

/** Which entities of a kind, in what order: equal on every field in `where`. */
export interface Query<E> {
  where?: { [F in FieldOf<E>]?: E[F] };
  orderBy?: { field: FieldOf<E>; desc?: boolean };
  limit?: number;
}

/**
 * Storage for entities, implemented once per platform. Between write()'s load and its
 * commit no other write may run; each Store guarantees it.
 */
export interface Store<E extends EntityBase> {
  find<K extends E['kind']>(
    kind: K,
    query?: Query<Extract<E, { kind: K }>>,
  ): Promise<Extract<E, { kind: K }>[]>;
  /** How many entities of a kind exist or, with `distinct`, how many values that field takes. */
  count<K extends E['kind']>(kind: K, distinct?: FieldOf<Extract<E, { kind: K }>>): Promise<number>;
  /** For each value of `groupBy`, the entity with the highest `orderBy`; highest group first. */
  newestPer<K extends E['kind']>(
    kind: K,
    groupBy: FieldOf<Extract<E, { kind: K }>>,
    orderBy: FieldOf<Extract<E, { kind: K }>>,
  ): Promise<Extract<E, { kind: K }>[]>;
  /** Writes every entity given, all or nothing. */
  commit(entities: E[]): Promise<void>;
}

/**
 * One kind of entity and the rules for changing it. load reads what the rules need;
 * apply decides, as a pure function, which entities to write. A change can touch several
 * entities, of any kind; none means nothing changed. Entities themselves stay plain
 * data, so they cross JSON, storage and devices unchanged.
 */
export abstract class EntityType<E extends EntityBase, C, Code extends string, Context> {
  abstract readonly kind: E['kind'];
  abstract load(store: Store<E>, change: C): Promise<Context>;
  /** `now` is the clock of whoever runs the rules, in Unix milliseconds. */
  abstract apply(context: Context, change: C, meta: Meta, now: number): Checked<E[], Code>;
  /** The types an EntityType works with, for the compiler only. */
  declare readonly types: { entity: E; change: C; code: Code };
}

/** Applies a change and commits the entities it produces. */
export async function write<E extends EntityBase, C, Code extends string, Context>(
  type: EntityType<E, C, Code, Context>,
  store: Store<E>,
  change: C,
  meta: Meta,
  now: number,
): Promise<Checked<E[], Code>> {
  const result = type.apply(await type.load(store, change), change, meta, now);
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
