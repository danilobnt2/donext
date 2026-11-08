/**
 * What every change has in common, whatever kind of entity it touches: who made it, how
 * a broken rule is reported, and how a change is written. Each kind (To-Dos now, Tasks
 * later) is an EntityType with its rules; each platform (the Durable Object now, devices
 * later) supplies its storage as a Store; write() joins the two.
 *
 * Every entity is kept as versions: an entity value is one version of an item, and an
 * item's current state is its newest version. Versions are never edited; a change
 * appends new ones.
 */

/** Rule violations any kind of entity can report. Each kind adds its own codes. */
export type RuleViolationCode = 'invalid_change' | 'invalid_device';

/** A parsed value, or the rule it broke. `Code` is the codes that may be reported. */
export type Checked<T, Code extends string = RuleViolationCode> =
  { ok: true; value: T } | { ok: false; code: Code; message: string };

/** Versions kept per item, of any kind. Older ones are dropped first; the newest is always kept. */
export const VERSION_LIMIT = 1000;

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

/** What every version holds, whatever its kind. Times are Unix milliseconds. */
export interface EntityBase extends Meta {
  /** The kind of entity, such as 'todo'. */
  kind: string;
  id: string;
  /** The version number, starting at 1. */
  version: number;
  /** When the item was created; copied into every version, since old ones get dropped. */
  createdAt: number;
  /** The kind of change, such as 'create' or 'edit'. */
  change: string;
  changedFields: readonly string[];
  /** When the change was accepted, on the clock of whoever runs the rules. */
  changedAt: number;
}

/**
 * Storage for entities, implemented once per platform. Between write()'s load and its
 * commit no other write may run; each Store guarantees it.
 */
export interface Store<E extends EntityBase> {
  /** An item's newest version. */
  get<K extends E['kind']>(kind: K, id: string): Promise<Extract<E, { kind: K }> | null>;
  /** How many items of a kind exist. */
  count(kind: E['kind']): Promise<number>;
  /**
   * Appends every version, then drops each item's versions below
   * oldestKeptVersion(newest), all or nothing.
   */
  commit(versions: E[]): Promise<void>;
}

/**
 * One kind of entity and the rules for changing it. load reads what the rules need;
 * apply decides, as a pure function, which versions to append. A change can touch
 * several items, of any kind; no versions means nothing changed. Entities themselves
 * stay plain data, so they cross JSON, storage and devices unchanged.
 */
export abstract class EntityType<E extends EntityBase, C, Code extends string, Context> {
  abstract readonly kind: E['kind'];
  abstract load(store: Store<E>, change: C): Promise<Context>;
  /** `now` is the clock of whoever runs the rules, in Unix milliseconds. */
  abstract apply(context: Context, change: C, meta: Meta, now: number): Checked<E[], Code>;
  /** The types an EntityType works with, for the compiler only. */
  declare readonly types: { entity: E; change: C; code: Code };
}

/** Applies a change and commits the versions it produces. */
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

/** Lowest version number of an item to keep once `newest` is written. */
export function oldestKeptVersion(newest: number): number {
  return Math.max(1, newest - VERSION_LIMIT + 1);
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
