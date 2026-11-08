/**
 * What every change has in common, whatever kind of item it touches: who made it, how a
 * broken rule is reported, and how a change is written. Each kind (To-Dos now, Tasks
 * later) supplies its rules as a Kind; each platform (the Durable Object now, IndexedDB
 * on devices later) supplies its storage as a Store; write() joins the two.
 */

/** Who or what made a change. Connectors arrive with AI connectors. */
export type Actor =
  | { kind: 'device'; id: string | null }
  | { kind: 'system'; id: null }
  | { kind: 'connector'; id: string };

/** Rule violations any kind of item can report. Each kind adds its own codes. */
export type RuleViolationCode = 'invalid_change' | 'invalid_device';

/** A parsed value, or the rule it broke. `Code` is the codes the parser may report. */
export type Checked<T, Code extends string = RuleViolationCode> =
  { ok: true; value: T } | { ok: false; code: Code; message: string };

/** Versions kept per item, of any kind. Older ones are dropped first; the newest is always kept. */
export const VERSION_LIMIT = 1000;

/** Who made a change and, for a device, when on its own clock. */
export interface Meta {
  actor: Actor;
  deviceChangedAt: number | null;
}

/** What every version holds, whatever its kind. Times are Unix milliseconds. */
export interface VersionBase {
  /** The kind of item, such as 'todo'. */
  kind: string;
  id: string;
  version: number;
  createdAt: number;
  /** The kind of change, such as 'create' or 'edit'. */
  change: string;
  changedFields: readonly string[];
  /** When the change was accepted, on the clock of whoever runs these rules. */
  changedAt: number;
  deviceChangedAt: number | null;
  actor: Actor;
}

/** A version to append, and the lowest version of its item to keep afterwards. */
export interface Commit<V extends VersionBase> {
  version: V;
  keepFrom: number;
}

/**
 * Storage for versions, implemented once per platform. Between write()'s load and its
 * commit no other write may run; each Store guarantees it.
 */
export interface Store<V extends VersionBase> {
  newest<K extends V['kind']>(kind: K, id: string): Promise<Extract<V, { kind: K }> | null>;
  count(kind: V['kind']): Promise<number>;
  /** Appends every version and drops the ones below keepFrom, all or nothing. */
  commit(commits: Commit<V>[]): Promise<void>;
}

/**
 * The rules for one kind of change. load reads what the rules need; apply decides, as a
 * pure function, which versions to append. A change can touch several items, of any
 * kind; no versions means nothing changed.
 */
export interface Kind<V extends VersionBase, C, Code extends string, Context> {
  load(store: Store<V>, change: C): Promise<Context>;
  apply(context: Context, change: C, meta: Meta, now: number): Checked<V[], Code>;
}

/** Applies a change and commits the versions it produces. */
export async function write<V extends VersionBase, C, Code extends string, Context>(
  kind: Kind<V, C, Code, Context>,
  store: Store<V>,
  change: C,
  meta: Meta,
  now: number,
): Promise<Checked<V[], Code>> {
  const result = kind.apply(await kind.load(store, change), change, meta, now);
  if (result.ok && result.value.length > 0) {
    await store.commit(
      result.value.map((version) => ({ version, keepFrom: oldestKeptVersion(version.version) })),
    );
  }
  return result;
}

/** Lowest version number to keep once `newest` is written. */
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

export function isObject(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

export function violation<Code extends string>(
  code: Code,
  message: string,
): { ok: false; code: Code; message: string } {
  return { ok: false, code, message };
}
