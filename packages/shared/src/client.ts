import { isTerminal } from './entity';
import type { EntityItem, Fields, Schemas } from './entity';
import { checkCreate, checkUpdate } from './rules';
import { MAX_OPS_PER_PUSH, MAX_PULL_LIMIT } from './sync';
import type { OpResult, PullResponse, RejectReason, SyncOp } from './sync';

/*
 * The client side of sync. A device keeps two things: the items the server last confirmed, and
 * an outbox of changes the server has not seen yet. What the user sees is the confirmed items
 * with the outbox applied on top. A change the server rejects is simply dropped from the
 * outbox, which puts the screen back to the server's version.
 *
 * The engine knows nothing about browsers, and nothing about what the items are: storage and
 * network come in through `LocalStore` and `Transport`, and the meaning of the data through
 * the schemas. It runs the same in a tab, a service worker and a test.
 */

export interface StoreSnapshot {
  deviceId: string | null;
  cursor: number;
  items: EntityItem[];
  outbox: SyncOp[];
}

export interface StoreChange {
  deviceId?: string;
  /** Forget every confirmed item and reset the cursor, because the server was reset. */
  clear?: boolean;
  /** Confirmed items to store. One never replaces a newer revision of the same item. */
  put?: EntityItem[];
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
  now?: () => string;
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

/**
 * Every item as this device sees it: the confirmed ones with the outbox applied, finished
 * items included (they stay until their own rules say otherwise). A change the rules would
 * refuse is skipped, as the server will refuse it.
 */
export function projectItems(
  confirmed: Iterable<EntityItem>,
  outbox: readonly SyncOp[],
  schemas: Schemas,
): Map<string, EntityItem> {
  const items = new Map<string, EntityItem>();
  for (const item of confirmed) items.set(item.id, item);
  const ctx = { get: (id: string) => items.get(id) };

  for (const op of outbox) {
    if (op.kind === 'create') {
      const schema = schemas[op.entity];
      if (!schema || items.has(op.itemId)) continue;
      const checked = checkCreate(schema, op.fields, ctx);
      if (!checked.ok) continue;
      items.set(op.itemId, {
        id: op.itemId,
        entity: op.entity,
        rev: 0,
        createdAt: op.clientChangedAt,
        updatedAt: op.clientChangedAt,
        fields: checked.fields,
      });
      continue;
    }

    const current = items.get(op.itemId);
    const schema = current ? schemas[current.entity] : undefined;
    if (!current || !schema) continue;
    const checked = checkUpdate(schema, current, op.changes, ctx);
    if (checked.ok && checked.changedFields.length > 0) {
      items.set(op.itemId, { ...current, fields: checked.next });
    }
  }
  return items;
}

/** The items of one kind to show: finished ones hidden, newest first. */
export function visibleItems(
  items: Iterable<EntityItem>,
  entity: string,
  schemas: Schemas,
): EntityItem[] {
  const schema = schemas[entity];
  return [...items]
    .filter((item) => item.entity === entity && !isTerminal(schema, item))
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** A `LocalStore` that lives in memory: for tests, and as a fallback where nothing persists. */
export class MemoryStore implements LocalStore {
  private deviceId: string | null = null;
  private cursor = 0;
  private items = new Map<string, EntityItem>();
  private outbox: SyncOp[] = [];

  async load(): Promise<StoreSnapshot> {
    return {
      deviceId: this.deviceId,
      cursor: this.cursor,
      items: [...this.items.values()],
      outbox: [...this.outbox],
    };
  }

  async commit(change: StoreChange): Promise<void> {
    if (change.deviceId !== undefined) this.deviceId = change.deviceId;
    if (change.clear) {
      this.items.clear();
      this.cursor = 0;
    }
    for (const item of change.put ?? []) {
      if (item.rev >= (this.items.get(item.id)?.rev ?? 0)) this.items.set(item.id, item);
    }
    this.outbox.push(...(change.addOps ?? []));
    if (change.dropOps) {
      const drop = new Set(change.dropOps);
      this.outbox = this.outbox.filter((op) => !drop.has(op.opId));
    }
    if (change.cursor !== undefined) this.cursor = Math.max(this.cursor, change.cursor);
  }
}

export class SyncEngine {
  private readonly confirmed = new Map<string, EntityItem>();
  private outbox: SyncOp[];
  private cursor: number;
  private readonly rejectionList: Rejection[] = [];
  private readonly listeners = new Set<() => void>();
  private running: Promise<SyncOutcome> | null = null;
  private runAgain = false;
  private connected = true;
  private projected: Map<string, EntityItem> | null = null;
  private readonly viewCache = new Map<string, readonly EntityItem[]>();

  private constructor(
    private readonly options: EngineOptions,
    private readonly deviceId: string,
    snapshot: StoreSnapshot,
  ) {
    for (const item of snapshot.items) this.confirmed.set(item.id, item);
    this.outbox = [...snapshot.outbox];
    this.cursor = snapshot.cursor;
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

  /** The live items of one kind, newest first. The same array is returned until something changes. */
  items(entity: string): readonly EntityItem[] {
    let view = this.viewCache.get(entity);
    if (!view) {
      view = visibleItems(this.project().values(), entity, this.options.schemas);
      this.viewCache.set(entity, view);
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

  /** Creates an item of the given kind. Refused, with a reason to show, if its rules say no. */
  async create(entity: string, fields: Fields): Promise<CreateResult> {
    const schema = this.options.schemas[entity];
    if (!schema) throw new Error(`There is no schema named “${entity}”.`);
    const checked = checkCreate(schema, fields, this.context());
    if (!checked.ok) return { ok: false, message: checked.message };

    // Send what the user gave, in its stored form; the server fills in the rest itself.
    const sent: Fields = {};
    for (const name of Object.keys(fields)) sent[name] = checked.fields[name] ?? null;

    const id = this.options.newId();
    await this.apply({
      addOps: [
        {
          kind: 'create',
          opId: this.options.newId(),
          entity,
          itemId: id,
          fields: sent,
          clientChangedAt: this.now(),
        },
      ],
    });
    return { ok: true, id };
  }

  /** Changes fields of an item. Changing nothing is fine and sends nothing. */
  async update(id: string, changes: Fields): Promise<MutationResult> {
    const op = this.updateOp(id, changes);
    if (!op.ok) return op;
    if (op.op) await this.apply({ addOps: [op.op] });
    return { ok: true };
  }

  /** Makes the same change to several items. Returns how many were changed. */
  async updateMany(ids: readonly string[], changes: Fields): Promise<number> {
    const ops: SyncOp[] = [];
    for (const id of ids) {
      const op = this.updateOp(id, changes);
      if (op.ok && op.op) ops.push(op.op);
    }
    if (ops.length > 0) await this.apply({ addOps: ops });
    return ops.length;
  }

  /**
   * Sends the outbox, then pulls what other devices did. Calls made while a sync is running
   * share it, and ask for one more pass so changes made in the meantime are not left behind.
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
      await this.pushOutbox();
      await this.pullRevisions();
      this.connected = true;
      return { ok: true };
    } catch (error) {
      this.connected = false;
      return { ok: false, error };
    }
  }

  private async pushOutbox(): Promise<void> {
    while (this.outbox.length > 0) {
      const batch = this.outbox.slice(0, MAX_OPS_PER_PUSH);
      const results = await this.options.transport.push(this.deviceId, batch);
      if (results.length !== batch.length) {
        throw new Error('The server answered a different number of changes than were sent.');
      }

      const put: EntityItem[] = [];
      for (const [index, op] of batch.entries()) {
        const result = results[index]!;
        if (result.status === 'rejected') {
          this.rejectionList.push({ op, reason: result.reason, message: result.message });
        } else if (result.revision) {
          put.push(result.revision.item);
        }
      }
      await this.apply({ put, dropOps: batch.map((op) => op.opId) });
    }
  }

  private async pullRevisions(): Promise<void> {
    for (;;) {
      const page = await this.options.transport.pull(this.cursor, MAX_PULL_LIMIT);
      if (this.cursor > page.latestSeq) {
        // The server is behind this device: it was reset. Start over from what it has now.
        await this.apply({ clear: true });
        continue;
      }
      const last = page.revisions.at(-1);
      await this.apply({
        put: page.revisions.map((revision) => revision.item),
        ...(last ? { cursor: last.seq } : {}),
      });
      if (!page.hasMore || !last) return;
    }
  }

  /** Writes to the store first, then to memory, so memory never gets ahead of the disk. */
  private async apply(change: StoreChange): Promise<void> {
    await this.options.store.commit(change);

    if (change.clear) {
      this.confirmed.clear();
      this.cursor = 0;
    }
    for (const item of change.put ?? []) {
      if (item.rev >= (this.confirmed.get(item.id)?.rev ?? 0)) this.confirmed.set(item.id, item);
    }
    this.outbox.push(...(change.addOps ?? []));
    if (change.dropOps) {
      const drop = new Set(change.dropOps);
      this.outbox = this.outbox.filter((op) => !drop.has(op.opId));
    }
    if (change.cursor !== undefined) this.cursor = Math.max(this.cursor, change.cursor);
    this.notify();
  }

  private updateOp(
    id: string,
    changes: Fields,
  ): { ok: true; op: SyncOp | null } | { ok: false; message: string } {
    const current = this.project().get(id);
    const schema = current ? this.options.schemas[current.entity] : undefined;
    if (!current || !schema) return { ok: false, message: 'No such item.' };

    const checked = checkUpdate(schema, current, changes, this.context());
    if (!checked.ok) return { ok: false, message: checked.message };
    if (checked.changedFields.length === 0) return { ok: true, op: null };

    const sent: Fields = {};
    for (const name of checked.changedFields) sent[name] = checked.next[name] ?? null;
    return {
      ok: true,
      op: {
        kind: 'update',
        opId: this.options.newId(),
        itemId: id,
        baseRev: this.confirmed.get(id)?.rev ?? 0,
        changes: sent,
        clientChangedAt: this.now(),
      },
    };
  }

  private project(): Map<string, EntityItem> {
    this.projected ??= projectItems(this.confirmed.values(), this.outbox, this.options.schemas);
    return this.projected;
  }

  private context() {
    const items = this.project();
    return { get: (id: string) => items.get(id) };
  }

  private now(): string {
    return this.options.now ? this.options.now() : new Date().toISOString();
  }

  private notify(): void {
    this.projected = null;
    this.viewCache.clear();
    for (const listener of this.listeners) listener();
  }
}
