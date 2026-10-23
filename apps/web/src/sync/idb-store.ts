import type { EntityItem, LocalStore, StoreChange, StoreSnapshot, SyncOp } from '@donext/shared';

const DB_VERSION = 1;
const STORES = ['meta', 'items', 'outbox'];

/** The outbox keeps its order from IndexedDB's auto-incrementing key. */
interface OutboxRecord {
  opId: string;
  op: SyncOp;
}

/**
 * This device's copy of the data, in IndexedDB: the confirmed To-Dos, the outbox of changes
 * the server has not seen, the sync cursor and the device id. Every commit is a single
 * transaction, so a crash or an error never leaves it half-written.
 */
export class IdbStore implements LocalStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = 'donext', factory: IDBFactory = indexedDB): Promise<IdbStore> {
    const request = factory.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('meta');
      db.createObjectStore('items', { keyPath: 'id' });
      db.createObjectStore('outbox', { autoIncrement: true }).createIndex('opId', 'opId', {
        unique: true,
      });
    };
    const db = await requestResult(request);
    // Let another tab upgrade the database instead of blocking it.
    db.onversionchange = () => db.close();
    return new IdbStore(db);
  }

  async load(): Promise<StoreSnapshot> {
    const tx = this.db.transaction(STORES, 'readonly');
    const meta = tx.objectStore('meta');
    const [deviceId, cursor, items, records] = await Promise.all([
      requestResult(meta.get('deviceId')),
      requestResult(meta.get('cursor')),
      requestResult<EntityItem[]>(tx.objectStore('items').getAll()),
      requestResult<OutboxRecord[]>(tx.objectStore('outbox').getAll()),
    ]);
    return {
      deviceId: typeof deviceId === 'string' ? deviceId : null,
      cursor: typeof cursor === 'number' ? cursor : 0,
      items,
      outbox: records.map((record) => record.op),
    };
  }

  async commit(change: StoreChange): Promise<void> {
    const tx = this.db.transaction(STORES, 'readwrite');
    const done = transactionDone(tx);
    done.catch(() => {}); // reported through the await below, or by the throw that aborted it
    try {
      const meta = tx.objectStore('meta');
      const items = tx.objectStore('items');
      const outbox = tx.objectStore('outbox');

      if (change.deviceId !== undefined) meta.put(change.deviceId, 'deviceId');
      if (change.clear) {
        items.clear();
        meta.put(0, 'cursor');
      }
      for (const item of change.put ?? []) {
        const existing = await requestResult<EntityItem | undefined>(items.get(item.id));
        if (item.rev >= (existing?.rev ?? 0)) items.put(item);
      }
      for (const op of change.addOps ?? []) outbox.add({ opId: op.opId, op });
      for (const opId of change.dropOps ?? []) {
        const key = await requestResult(outbox.index('opId').getKey(opId));
        if (key !== undefined) outbox.delete(key);
      }
      if (change.cursor !== undefined) {
        const current = await requestResult(meta.get('cursor'));
        meta.put(Math.max(typeof current === 'number' ? current : 0, change.cursor), 'cursor');
      }
    } catch (error) {
      tx.abort();
      throw error;
    }
    await done;
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('The transaction was aborted.'));
  });
}
