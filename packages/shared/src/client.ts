import { schemaFor } from './entity';
import type { EntityItem, Fields, Schemas } from './entity';
import { checkCreate, checkUpdate } from './rules';
import { MAX_OPS_PER_PUSH, MAX_PULL_LIMIT } from './sync';
import type { Change, OpResult, PullResponse, RejectReason, SyncOp } from './sync';

/*
 * The device side of sync. A device keeps a mirror of the server's rows, each with the sync
 * number of its last write, and an outbox of changes the server has not confirmed. What the user
 * sees is the mirror with the outbox applied on top. A change the server rejects is dropped
 * from the outbox, which puts the screen back to the server's version.
 *
 * The engine knows nothing about browsers or about what the items are: storage and network come
 * in through `LocalStore` and `Transport`, and the meaning of the data through the schemas.
 */

/** A mirrored row, with the sync number of the write it reflects. */
export interface StoredItem {
  seq: number;
  item: EntityItem;
}

export interface StoreSnapshot {
  deviceId: string | null;
  cursor: number;
  /** The server epoch the mirror belongs to; null before the first pull. */
  epoch: number | null;
  items: StoredItem[];
  outbox: SyncOp[];
}

export interface StoreChange {
  deviceId?: string;
  epoch?: number;
  /** Forget the whole mirror and reset the cursor. The outbox is kept. */
  clear?: boolean;
  /** Rows to take on: an item replaces an older write of it, a null item removes it. */
  changes?: Change[];
  addOps?: SyncOp[];
  dropOps?: string[];
  /** The cursor only moves forward: a lower value than the stored one is ignored. */
  cursor?: number;
}

export interface LocalStore {
  load(): Promise<StoreSnapshot>;
  /** Applies the whole change or none of it, in the order of the fields above. */
  commit(change: StoreChange): Promise<void>;
}

/** Both methods throw when the server cannot be reached or answers with an error. */
export interface Transport {
  push(deviceId: string, ops: SyncOp[]): Promise<OpResult[]>;
  pull(after: number, limit: number): Promise<PullResponse>;
}

export interface EngineOptions {
  store: LocalStore;
  transport: Transport;
  schemas: Schemas;
  /** Returns a fresh ULID. Used for device, operation and item ids. */
  newId: () => string;
}

/** A change the server refused. The screen has already gone back to the server's version. */
export interface Rejection {
  op: SyncOp;
  reason: RejectReason;
  message: string;
}

export interface SyncStatus {
  /** Changes made here that the server has not confirmed yet. */
  pending: number;
  syncing: boolean;
  /** False after a sync failed, until one succeeds. */
  connected: boolean;
}

export type SyncOutcome = { ok: true } | { ok: false; error: unknown };
export type MutationResult = { ok: true } | { ok: false; message: string };
export type CreateResult = { ok: true; id: string } | { ok: false; message: string };

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** When a ULID was made, as an ISO time: what a device shows as an item's creation time until the server says. */
export function ulidTime(id: string): string {
  let ms = 0;
  for (const char of id.slice(0, 10)) ms = ms * 32 + Math.max(0, CROCKFORD.indexOf(char));
  return new Date(ms).toISOString();
}

/** Takes on one row from the server: newer writes replace older ones, and deletions remove. */
export function takeChange(mirror: Map<string, StoredItem>, change: Change): void {
  const current = mirror.get(change.id);
  if (current && current.seq >= change.seq) return;
  if (change.item) mirror.set(change.id, { seq: change.seq, item: change.item });
  else mirror.delete(change.id);
}

/** Every item as this device sees it: the mirror with the outbox applied, in order. */
export function projectItems(
  mirror: Iterable<EntityItem>,
  outbox: readonly SyncOp[],
  schemas: Schemas,
): Map<string, EntityItem> {
  const items = new Map<string, EntityItem>();
  for (const item of mirror) items.set(item.id, item);
  const ctx = { get: (id: string) => items.get(id) };

  for (const op of outbox) {
    const schema = schemaFor(schemas, op.entity);
    if (!schema) continue;
    if (op.kind === 'create') {
      if (items.has(op.itemId)) continue;
      const checked = checkCreate(schema, op.fields, ctx);
      if (!checked.ok) continue;
      const createdAt = ulidTime(op.itemId);
      items.set(op.itemId, {
        id: op.itemId,
        entity: op.entity,
        rev: 0,
        createdAt,
        updatedAt: createdAt,
        fields: checked.fields,
      });
    } else if (op.kind === 'update') {
      const current = items.get(op.itemId);
      if (!current) continue;
      const checked = checkUpdate(schema, current, op.changes, ctx);
      if (checked.ok) items.set(op.itemId, { ...current, fields: checked.fields });
    } else {
      items.delete(op.itemId);
    }
  }
  return items;
}

/** A `LocalStore` that lives in memory: for tests, and where nothing can persist. */
export class MemoryStore implements LocalStore {
  private deviceId: string | null = null;
  private cursor = 0;
  private epoch: number | null = null;
  private mirror = new Map<string, StoredItem>();
  private outbox: SyncOp[] = [];

  async load(): Promise<StoreSnapshot> {
    return {
      deviceId: this.deviceId,
      cursor: this.cursor,
      epoch: this.epoch,
      items: [...this.mirror.values()],
      outbox: [...this.outbox],
    };
  }

  async commit(change: StoreChange): Promise<void> {
    if (change.deviceId !== undefined) this.deviceId = change.deviceId;
    if (change.epoch !== undefined) this.epoch = change.epoch;
    if (change.clear) {
      this.mirror.clear();
      this.cursor = 0;
    }
    for (const row of change.changes ?? []) takeChange(this.mirror, row);
    this.outbox.push(...(change.addOps ?? []));
    if (change.dropOps) {
      const drop = new Set(change.dropOps);
      this.outbox = this.outbox.filter((op) => !drop.has(op.opId));
    }
    if (change.cursor !== undefined) this.cursor = Math.max(this.cursor, change.cursor);
  }
}

export class SyncEngine {
  private readonly mirror = new Map<string, StoredItem>();
  private outbox: SyncOp[];
  private cursor: number;
  private epoch: number | null;
  private readonly rejectionList: Rejection[] = [];
  private readonly listeners = new Set<() => void>();
  private running: Promise<SyncOutcome> | null = null;
  private runAgain = false;
  private connected = true;
  private projected: Map<string, EntityItem> | null = null;
  private readonly views = new Map<string, readonly EntityItem[]>();

  private constructor(
    private readonly options: EngineOptions,
    private readonly deviceId: string,
    snapshot: StoreSnapshot,
  ) {
    for (const row of snapshot.items) this.mirror.set(row.item.id, row);
    this.outbox = [...snapshot.outbox];
    this.cursor = snapshot.cursor;
    this.epoch = snapshot.epoch;
  }

  /** Loads what is stored on this device. Call `sync()` afterwards to catch up. */
  static async open(options: EngineOptions): Promise<SyncEngine> {
    const snapshot = await options.store.load();
    let { deviceId } = snapshot;
    if (deviceId === null) {
      deviceId = options.newId();
      await options.store.commit({ deviceId });
    }
    return new SyncEngine(options, deviceId, snapshot);
  }

  /** The items of one kind, newest first. The same array is returned until something changes. */
  items(entity: string): readonly EntityItem[] {
    let view = this.views.get(entity);
    if (!view) {
      view = [...this.project().values()]
        .filter((item) => item.entity === entity)
        .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      this.views.set(entity, view);
    }
    return view;
  }

  status(): SyncStatus {
    return {
      pending: this.outbox.length,
      syncing: this.running !== null,
      connected: this.connected,
    };
  }

  rejections(): readonly Rejection[] {
    return this.rejectionList;
  }

  dismissRejection(opId: string): void {
    const index = this.rejectionList.findIndex((rejection) => rejection.op.opId === opId);
    if (index === -1) return;
    this.rejectionList.splice(index, 1);
    this.notify();
  }

  /** Calls `listener` whenever the items, the status or the rejections change. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Creates an item. Refused, with a reason to show, if its rules say no. */
  async create(entity: string, fields: Fields): Promise<CreateResult> {
    const schema = schemaFor(this.options.schemas, entity);
    if (!schema) throw new Error(`There is no schema named “${entity}”.`);
    const checked = checkCreate(schema, fields, this.context());
    if (!checked.ok) return { ok: false, message: checked.message };

    // Send what the user gave, in its stored form; the server fills in the rest itself.
    const sent: Fields = {};
    for (const name of Object.keys(fields)) sent[name] = checked.fields[name] ?? null;
    const id = this.options.newId();
    await this.enqueue([
      { kind: 'create', opId: this.options.newId(), entity, itemId: id, fields: sent },
    ]);
    return { ok: true, id };
  }

  /** Changes fields of an item. Changing nothing is fine and sends nothing. */
  async update(id: string, changes: Fields): Promise<MutationResult> {
    const current = this.project().get(id);
    const schema = current && schemaFor(this.options.schemas, current.entity);
    if (!current || !schema) return { ok: false, message: 'No such item.' };
    const checked = checkUpdate(schema, current, changes, this.context());
    if (!checked.ok) return { ok: false, message: checked.message };
    if (checked.changedFields.length === 0) return { ok: true };

    const sent: Fields = {};
    for (const name of checked.changedFields) sent[name] = checked.fields[name] ?? null;
    await this.enqueue([
      {
        kind: 'update',
        opId: this.options.newId(),
        entity: current.entity,
        itemId: id,
        baseRev: this.mirror.get(id)?.item.rev ?? 0,
        changes: sent,
      },
    ]);
    return { ok: true };
  }

  /** Deletes items for good, on every device. Returns how many there were. */
  async delete(ids: readonly string[]): Promise<number> {
    const items = this.project();
    const ops: SyncOp[] = ids
      .map((id) => items.get(id))
      .filter((item) => item !== undefined)
      .map((item) => ({
        kind: 'delete',
        opId: this.options.newId(),
        entity: item.entity,
        itemId: item.id,
      }));
    if (ops.length > 0) await this.enqueue(ops);
    return ops.length;
  }

  /**
   * Sends the outbox, then pulls what changed. Calls made while a sync is running share it, and
   * ask for one more pass so changes made in the meantime are not left behind.
   */
  sync(): Promise<SyncOutcome> {
    if (this.running) {
      this.runAgain = true;
      return this.running;
    }
    this.running = this.syncUntilQuiet();
    this.notify();
    return this.running;
  }

  private async syncUntilQuiet(): Promise<SyncOutcome> {
    let outcome: SyncOutcome;
    try {
      do {
        this.runAgain = false;
        outcome = await this.syncOnce();
      } while (this.runAgain && outcome.ok);
    } finally {
      // Cleared in the same turn as the last check of `runAgain`, so no call can slip between.
      this.running = null;
    }
    this.notify();
    return outcome;
  }

  private async syncOnce(): Promise<SyncOutcome> {
    try {
      const accepted = await this.push();
      await this.pull();
      // Confirmed changes leave the outbox only now that the mirror shows them, so the screen
      // never flickers back to the old version in between.
      if (accepted.length > 0) await this.apply({ dropOps: accepted });
      this.connected = true;
      return { ok: true };
    } catch (error) {
      this.connected = false;
      return { ok: false, error };
    }
  }

  /** Sends every change in the outbox. Returns the ones the server took. */
  private async push(): Promise<string[]> {
    const accepted: string[] = [];
    const sent = new Set<string>();
    for (;;) {
      const batch = this.outbox.filter((op) => !sent.has(op.opId)).slice(0, MAX_OPS_PER_PUSH);
      if (batch.length === 0) return accepted;
      const results = await this.options.transport.push(this.deviceId, batch);
      if (results.length !== batch.length) {
        throw new Error('The server answered a different number of changes than were sent.');
      }

      const refused: string[] = [];
      for (const [index, op] of batch.entries()) {
        sent.add(op.opId);
        const result = results[index]!;
        if (result.status === 'rejected') {
          this.rejectionList.push({ op, reason: result.reason, message: result.message });
          refused.push(op.opId);
        } else {
          accepted.push(op.opId);
        }
      }
      if (refused.length > 0) await this.apply({ dropOps: refused });
    }
  }

  private async pull(): Promise<void> {
    for (;;) {
      const page = await this.options.transport.pull(this.cursor, MAX_PULL_LIMIT);
      if (page.resync || (this.epoch !== null && page.epoch !== this.epoch)) {
        // The server cannot say what changed since our cursor, or its data started over.
        // Drop the mirror and take everything again; changes still in the outbox are kept.
        await this.apply({ clear: true, ...(page.resync ? {} : { epoch: page.epoch }) });
        continue;
      }

      // An app older than the server may meet kinds it has no schema for. It moves past them;
      // a newer app starts its mirror again and picks them up.
      const known = page.changes.filter((change) => schemaFor(this.options.schemas, change.entity));
      const last = page.changes.at(-1)?.seq ?? this.cursor;
      await this.apply({
        ...(this.epoch === null ? { epoch: page.epoch } : {}),
        changes: known,
        cursor: page.hasMore ? last : Math.max(last, page.latestSeq),
      });
      if (!page.hasMore) return;
    }
  }

  private enqueue(ops: SyncOp[]): Promise<void> {
    return this.apply({ addOps: ops });
  }

  /** Writes to the store first, then to memory, so memory never gets ahead of the disk. */
  private async apply(change: StoreChange): Promise<void> {
    await this.options.store.commit(change);

    if (change.epoch !== undefined) this.epoch = change.epoch;
    if (change.clear) {
      this.mirror.clear();
      this.cursor = 0;
    }
    for (const row of change.changes ?? []) takeChange(this.mirror, row);
    this.outbox.push(...(change.addOps ?? []));
    if (change.dropOps) {
      const drop = new Set(change.dropOps);
      this.outbox = this.outbox.filter((op) => !drop.has(op.opId));
    }
    if (change.cursor !== undefined) this.cursor = Math.max(this.cursor, change.cursor);
    this.notify();
  }

  private project(): Map<string, EntityItem> {
    this.projected ??= projectItems(
      [...this.mirror.values()].map((row) => row.item),
      this.outbox,
      this.options.schemas,
    );
    return this.projected;
  }

  private context() {
    const items = this.project();
    return { get: (id: string) => items.get(id) };
  }

  private notify(): void {
    this.projected = null;
    this.views.clear();
    for (const listener of this.listeners) listener();
  }
}
