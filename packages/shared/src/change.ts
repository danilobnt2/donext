/**
 * What every change has in common, whatever kind of entity it touches: who made it, how
 * a broken rule is reported, and how a change is written. Each kind is an EntityType with
 * its rules; each platform (the Durable Object now, devices later) supplies its storage
 * as a Store; write() joins the two. Nothing here knows what an entity means: To-Do
 * versions, for one, are just a kind of entity.
 */

/** Rule violations any kind of entity can report. Each kind adds its own codes. */
export type RuleViolationCode = 'invalid_change' | 'invalid_device';

/** A parsed value, or the rule it broke. `Code` is the codes that may be reported. */
export type Checked<T, Code extends string = RuleViolationCode> =
  { ok: true; value: T } | { ok: false; code: Code; message: string };

/** Who or what made a change. Connectors arrive with AI connectors. */
export type Actor =
  | { kind: 'device'; id: string | null }
  | { kind: 'system'; id: null }
  | { kind: 'connector'; id: string };

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

/** Which entities of a kind: equal on every field in `where`, below `before` on one field. */
export interface Filter<E> {
  where?: { [F in FieldOf<E>]?: E[F] };
  before?: { [F in FieldOf<E>]: { field: F; value: E[F] } }[FieldOf<E>];
}

export interface Query<E> extends Filter<E> {
  orderBy?: { field: FieldOf<E>; desc?: boolean };
  limit?: number;
}

/** Entities to write and entities to delete, by kind. */
export interface Writes<E extends EntityBase> {
  put: E[];
  delete: { [K in E['kind']]: { kind: K } & Filter<Extract<E, { kind: K }>> }[E['kind']][];
}

/**
 * Storage for entities, implemented once per platform. Between write()'s load and its
 * commit no other write may run; each Store guarantees it.
 */
export interface Store<E extends EntityBase> {
  get<K extends E['kind']>(kind: K, id: string): Promise<Extract<E, { kind: K }> | null>;
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
  /** Puts and deletes everything given, all or nothing. */
  commit(writes: Writes<E>): Promise<void>;
}

/**
 * One kind of entity and the rules for changing it. load reads what the rules need;
 * apply decides, as a pure function, which entities to put and delete. A change can
 * touch several entities, of any kind; no writes means nothing changed. Entities
 * themselves stay plain data, so they cross JSON, storage and devices unchanged.
 */
export abstract class EntityType<E extends EntityBase, C, Code extends string, Context> {
  abstract readonly kind: E['kind'];
  abstract load(store: Store<E>, change: C): Promise<Context>;
  /** `now` is the clock of whoever runs the rules, in Unix milliseconds. */
  abstract apply(context: Context, change: C, meta: Meta, now: number): Checked<Writes<E>, Code>;
  /** The types an EntityType works with, for the compiler only. */
  declare readonly types: { entity: E; change: C; code: Code };
}

/** Applies a change and commits the writes it produces. */
export async function write<E extends EntityBase, C, Code extends string, Context>(
  type: EntityType<E, C, Code, Context>,
  store: Store<E>,
  change: C,
  meta: Meta,
  now: number,
): Promise<Checked<Writes<E>, Code>> {
  const result = type.apply(await type.load(store, change), change, meta, now);
  if (result.ok && (result.value.put.length > 0 || result.value.delete.length > 0)) {
    await store.commit(result.value);
  }
  return result;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Reads the optional device id and device time of a change made on an app device. A
 * device time older or newer than the server's is accepted: offline edits arrive late.
 */
export function parseDeviceMeta(input: unknown): Checked<Meta & { actor: { kind: 'device' } }> {
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
    const text = body.deviceChangedAt;
    const time = typeof text === 'string' ? Date.parse(text) : NaN;
    if (!Number.isFinite(time) || !/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(String(text))) {
      return violation('invalid_device', 'deviceChangedAt must be an ISO 8601 time with a zone.');
    }
    deviceChangedAt = time;
  }
  return { ok: true, value: { actor: { kind: 'device', id }, deviceChangedAt } };
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
