import * as Automerge from '@automerge/automerge/slim';
import wasmUrl from '@automerge/automerge/automerge.wasm?url';
import {
  addTodo,
  decodeFrame,
  encodeFrame,
  headsEqual,
  listTodos,
  type ApiError,
  type BoardDoc,
  type Todo,
} from '@donext/shared';

const STORE = 'board';
let wasmReady: Promise<void> | null = null;

type StoredBoard = { docId: string; snapshot: Uint8Array };

/** Keeps a local Automerge board in IndexedDB and syncs it over WebSocket with the Worker. */
export class BoardClient {
  private db: IDBDatabase | null = null;
  private docId = '';
  private doc: Automerge.Doc<BoardDoc> | null = null;
  private syncState: Automerge.SyncState | null = null;
  private ws: WebSocket | null = null;
  private timer: number | null = null;
  private backoff = 250;
  private offline = false;
  private stopped = false;

  constructor(
    private readonly userId: string,
    private readonly onTodos: (todos: Todo[]) => void,
    private readonly onLoadError: (msg: string | null) => void,
  ) {}

  async start(): Promise<void> {
    try {
      await (wasmReady ??= Automerge.initializeWasm(wasmUrl));
    } catch (e) {
      return this.onLoadError((e as Error).message);
    }
    this.db = await openDb();
    if (this.stopped) return this.db?.close();

    const cached = await loadLocal(this.db, this.userId);
    if (this.stopped) return this.db?.close();
    if (cached) {
      this.docId = cached.docId;
      this.doc = Automerge.load<BoardDoc>(cached.snapshot);
      this.onTodos(listTodos(this.doc));
    }

    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    document.addEventListener('visibilitychange', this.onVisible);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    document.removeEventListener('visibilitychange', this.onVisible);
    if (this.timer !== null) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000);
    this.db?.close();
  }

  async createTodo(title: string): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!this.doc || !this.docId) return { ok: false, message: 'Board is still loading.' };
    const added = addTodo(this.doc, title);
    if (!added.ok) return added;
    this.doc = added.doc;
    this.onTodos(listTodos(this.doc));
    await saveLocal(this.db, this.userId, this.docId, Automerge.save(this.doc));
    this.flush();
    return { ok: true };
  }

  async deleteAllTodos(): Promise<void> {
    const res = await fetch('/api/v1/board', { method: 'DELETE' });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ApiError | null;
      throw new Error(body?.error.message ?? `Request failed (${res.status}).`);
    }
  }

  private readonly onOnline = (): void => {
    this.offline = false;
    this.backoff = 250;
    this.reconnect();
  };

  private readonly onOffline = (): void => {
    this.offline = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    this.syncState = null;
    ws?.close(1000);
  };

  private readonly onVisible = (): void => {
    if (document.visibilityState === 'visible') this.reconnect();
  };

  private reconnect(): void {
    if (this.stopped || this.offline || this.ws) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.connect();
  }

  private connect(): void {
    if (this.stopped || this.offline) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/v1/sync`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.backoff = 250;
      this.syncState = Automerge.initSyncState();
      this.flush();
    });

    ws.addEventListener('message', (e) => {
      if (this.ws === ws && e.data instanceof ArrayBuffer) {
        this.handleFrame(new Uint8Array(e.data));
      }
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.syncState = null;
      if (this.stopped || this.offline || this.timer !== null) return;
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, 5000);
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.connect();
      }, delay);
    });
  }

  private handleFrame(bytes: Uint8Array): void {
    const frame = decodeFrame(bytes);
    if (!frame) return;

    if (frame.kind === 'reset') {
      this.docId = frame.docId;
      this.doc = Automerge.load<BoardDoc>(frame.data);
      this.syncState = Automerge.initSyncState();
      this.onLoadError(null);
      this.onTodos(listTodos(this.doc));
      void saveLocal(this.db, this.userId, frame.docId, frame.data);
      this.flush();
      return;
    }

    if (!this.doc || !this.syncState || frame.docId !== this.docId) return;
    const prevHeads = Automerge.getHeads(this.doc);
    [this.doc, this.syncState] = Automerge.receiveSyncMessage(this.doc, this.syncState, frame.data);
    if (!headsEqual(prevHeads, Automerge.getHeads(this.doc))) {
      this.onTodos(listTodos(this.doc));
      void saveLocal(this.db, this.userId, this.docId, Automerge.save(this.doc));
    }
    this.flush();
  }

  private flush(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.syncState) return;
    if (!this.doc || !this.docId) {
      this.ws.send(encodeFrame('sync', ''));
      return;
    }
    const [next, msg] = Automerge.generateSyncMessage(this.doc, this.syncState);
    this.syncState = next;
    if (msg) this.ws.send(encodeFrame('sync', this.docId, msg));
  }
}

export async function clearCachedBoard(userId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(boardKey(userId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}

function boardKey(userId: string): string {
  return `board:${userId}`;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const req = indexedDB.open('donext', 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function loadLocal(db: IDBDatabase | null, userId: string): Promise<StoredBoard | null> {
  if (!db) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(boardKey(userId));
    req.onsuccess = () => resolve((req.result as StoredBoard | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

function saveLocal(
  db: IDBDatabase | null,
  userId: string,
  docId: string,
  snapshot: Uint8Array,
): Promise<void> {
  if (!db) return Promise.resolve();
  const copy = new Uint8Array(snapshot);
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ docId, snapshot: copy } satisfies StoredBoard, boardKey(userId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
