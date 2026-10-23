import { MAX_OPS_PER_PUSH, MAX_PULL_LIMIT } from './sync';
import type { OpResult, PullResponse, RejectReason, SyncOp } from './sync';
import { checkTitle } from './todo';
import type { Todo } from './todo';

/*
 * The client side of sync. A device keeps two things: the To-Dos the server last confirmed, and
 * an outbox of changes the server has not seen yet. What the user sees is the confirmed To-Dos
 * with the outbox applied on top. A change the server rejects is simply dropped from the
 * outbox, which puts the screen back to the server's version.
 *
 * The engine knows nothing about browsers: storage and network come in through `LocalStore`
 * and `Transport`, so it runs the same in a tab, a service worker and a test.
 */

export interface StoreSnapshot {
  deviceId: string | null;
  cursor: number;
  todos: Todo[];
  outbox: SyncOp[];
}

export interface StoreChange {
  deviceId?: string;
  /** Forget every confirmed To-Do and reset the cursor, because the server was reset. */
  clear?: boolean;
  /** Confirmed To-Dos to store. One never replaces a newer revision of the same To-Do. */
  put?: Todo[];
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
  /** Returns a fresh ULID. Used for device, operation and To-Do ids. */
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

/** The To-Dos to show: the confirmed ones with the outbox applied, abandoned ones hidden. */
export function projectTodos(confirmed: Iterable<Todo>, outbox: readonly SyncOp[]): Todo[] {
  const todos = new Map<string, Todo>();
  for (const todo of confirmed) todos.set(todo.id, todo);

  for (const op of outbox) {
    if (op.kind === 'create_todo') {
      const title = checkTitle(op.title);
      if (!title.ok || todos.has(op.itemId)) continue;
      todos.set(op.itemId, {
        id: op.itemId,
        title: title.title,
        state: 'new',
        rev: 0,
        createdAt: op.clientChangedAt,
        updatedAt: op.clientChangedAt,
      });
      continue;
    }

    const todo = todos.get(op.itemId);
    if (!todo || todo.state === 'abandoned') continue;
    const title = op.changes.title === undefined ? null : checkTitle(op.changes.title);
    todos.set(op.itemId, {
      ...todo,
      title: title?.ok ? title.title : todo.title,
      state: op.changes.state ?? todo.state,
    });
  }

  return [...todos.values()]
    .filter((todo) => todo.state !== 'abandoned')
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** A `LocalStore` that lives in memory: for tests, and as a fallback where nothing persists. */
export class MemoryStore implements LocalStore {
  private deviceId: string | null = null;
  private cursor = 0;
  private todos = new Map<string, Todo>();
  private outbox: SyncOp[] = [];

  async load(): Promise<StoreSnapshot> {
    return {
      deviceId: this.deviceId,
      cursor: this.cursor,
      todos: [...this.todos.values()],
      outbox: [...this.outbox],
    };
  }

  async commit(change: StoreChange): Promise<void> {
    if (change.deviceId !== undefined) this.deviceId = change.deviceId;
    if (change.clear) {
      this.todos.clear();
      this.cursor = 0;
    }
    for (const todo of change.put ?? []) {
      if (todo.rev >= (this.todos.get(todo.id)?.rev ?? 0)) this.todos.set(todo.id, todo);
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
  private readonly confirmed = new Map<string, Todo>();
  private outbox: SyncOp[];
  private cursor: number;
  private readonly rejectionList: Rejection[] = [];
  private readonly listeners = new Set<() => void>();
  private running: Promise<SyncOutcome> | null = null;
  private runAgain = false;
  private connected = true;
  private cachedView: Todo[] | null = null;

  private constructor(
    private readonly options: EngineOptions,
    private readonly deviceId: string,
    snapshot: StoreSnapshot,
  ) {
    for (const todo of snapshot.todos) this.confirmed.set(todo.id, todo);
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

  /** The To-Dos to show, newest first. The same array is returned until something changes. */
  view(): readonly Todo[] {
    this.cachedView ??= projectTodos(this.confirmed.values(), this.outbox);
    return this.cachedView;
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

  /** Calls `listener` whenever the view, the status or the rejections change. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async createTodo(title: unknown): Promise<CreateResult> {
    const check = checkTitle(title);
    if (!check.ok) return check;
    const id = this.options.newId();
    await this.apply({
      addOps: [
        {
          kind: 'create_todo',
          opId: this.options.newId(),
          itemId: id,
          title: check.title,
          clientChangedAt: this.now(),
        },
      ],
    });
    return { ok: true, id };
  }

  async renameTodo(id: string, title: unknown): Promise<MutationResult> {
    const check = checkTitle(title);
    if (!check.ok) return check;
    if (!this.view().some((todo) => todo.id === id))
      return { ok: false, message: 'No such To-Do.' };
    await this.apply({ addOps: [this.updateOp(id, { title: check.title })] });
    return { ok: true };
  }

  /** Hides the To-Dos from every device. Their history is kept. */
  async abandonTodos(ids: readonly string[]): Promise<number> {
    const visible = new Set(this.view().map((todo) => todo.id));
    const targets = ids.filter((id) => visible.has(id));
    if (targets.length > 0) {
      await this.apply({ addOps: targets.map((id) => this.updateOp(id, { state: 'abandoned' })) });
    }
    return targets.length;
  }

  abandonAll(): Promise<number> {
    return this.abandonTodos(this.view().map((todo) => todo.id));
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

      const put: Todo[] = [];
      for (const [index, op] of batch.entries()) {
        const result = results[index]!;
        if (result.status === 'rejected') {
          this.rejectionList.push({ op, reason: result.reason, message: result.message });
        } else if (result.revision) {
          put.push(result.revision.todo);
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
        put: page.revisions.map((revision) => revision.todo),
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
    for (const todo of change.put ?? []) {
      if (todo.rev >= (this.confirmed.get(todo.id)?.rev ?? 0)) this.confirmed.set(todo.id, todo);
    }
    this.outbox.push(...(change.addOps ?? []));
    if (change.dropOps) {
      const drop = new Set(change.dropOps);
      this.outbox = this.outbox.filter((op) => !drop.has(op.opId));
    }
    if (change.cursor !== undefined) this.cursor = Math.max(this.cursor, change.cursor);
    this.notify();
  }

  private updateOp(id: string, changes: { title?: string; state?: 'abandoned' }): SyncOp {
    return {
      kind: 'update_todo',
      opId: this.options.newId(),
      itemId: id,
      baseRev: this.confirmed.get(id)?.rev ?? 0,
      changes,
      clientChangedAt: this.now(),
    };
  }

  private now(): string {
    return this.options.now ? this.options.now() : new Date().toISOString();
  }

  private notify(): void {
    this.cachedView = null;
    for (const listener of this.listeners) listener();
  }
}
