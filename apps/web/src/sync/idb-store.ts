import type {
  EntityItem,
  FieldValue,
  LocalStore,
  StoreChange,
  StoreSnapshot,
  SyncOp,
} from '@donext/shared';
import { MIGRATIONS, type Migration } from './migrations';
import { STORES, type StoreMapping } from './stores';

/** The outbox keeps its order from IndexedDB's auto-incrementing key. */
interface OutboxRecord {
  opId: string;
  op: SyncOp;
}

/** A stored record: flat, with one property per field. */
type Row = Record<string, unknown>;

export interface IdbStoreOptions {
  migrations?: readonly Migration[];
  stores?: Readonly<Record<string, StoreMapping>>;
}

/**
 * This device's copy of the data, in IndexedDB: each kind in its own object store, the outbox
 * of changes the server has not seen, the sync cursor and the device id. Every commit is a
 * single transaction, so a crash or an error never leaves it half-written.
 */
export class IdbStore implements LocalStore {
  private readonly storeNames: string[];

  private constructor(
    private readonly db: IDBDatabase,
    private readonly stores: Readonly<Record<string, StoreMapping>>,
  ) {
    this.storeNames = ['meta', 'outbox', ...Object.keys(stores)];
  }

  static async open(
    name = 'donext',
    factory: IDBFactory = indexedDB,
    { migrations = MIGRATIONS, stores = STORES }: IdbStoreOptions = {},
  ): Promise<IdbStore> {
    const request = factory.open(name, migrations.length);
    request.onupgradeneeded = (event) => {
      const tx = request.transaction!;
      for (let version = event.oldVersion; version < migrations.length; version++) {
        migrations[version]!(request.result, tx);
      }
    };
    const db = await requestResult(request);
    // Let another tab upgrade the database instead of blocking it.
    db.onversionchange = () => db.close();
    return new IdbStore(db, stores);
  }

  async load(): Promise<StoreSnapshot> {
    const tx = this.db.transaction(this.storeNames, 'readonly');
    const meta = tx.objectStore('meta');
    const [deviceId, cursor, records, ...kinds] = await Promise.all([
      requestResult(meta.get('deviceId')),
      requestResult(meta.get('cursor')),
      requestResult<OutboxRecord[]>(tx.objectStore('outbox').getAll()),
      ...Object.keys(this.stores).map((entity) =>
        requestResult<Row[]>(tx.objectStore(entity).getAll()),
      ),
    ]);
    const mappings = Object.values(this.stores);
    return {
      deviceId: typeof deviceId === 'string' ? deviceId : null,
      cursor: typeof cursor === 'number' ? cursor : 0,
      items: kinds.flatMap((rows, index) => rows.map((row) => toItem(mappings[index]!, row))),
      outbox: records.map((record) => record.op),
    };
  }

  async commit(change: StoreChange): Promise<void> {
    const tx = this.db.transaction(this.storeNames, 'readwrite');
    const done = transactionDone(tx);
    done.catch(() => {}); // reported through the await below, or by the throw that aborted it
    try {
      const meta = tx.objectStore('meta');
      const outbox = tx.objectStore('outbox');

      if (change.deviceId !== undefined) meta.put(change.deviceId, 'deviceId');
      if (change.clear) {
        for (const entity of Object.keys(this.stores)) tx.objectStore(entity).clear();
        meta.put(0, 'cursor');
      }
      for (const item of change.put ?? []) {
        const mapping = this.stores[item.entity];
        if (!mapping) throw new Error(`This device has no store for “${item.entity}”.`);
        const store = tx.objectStore(item.entity);
        const existing = await requestResult<Row | undefined>(store.get(item.id));
        if (item.rev >= Number(existing?.rev ?? 0)) store.put(toRecord(mapping, item));
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

function toRecord(mapping: StoreMapping, item: EntityItem): Row {
  const record: Row = {
    id: item.id,
    rev: item.rev,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  for (const field of mapping.fields) record[field] = item.fields[field] ?? null;
  return record;
}

function toItem(mapping: StoreMapping, record: Row): EntityItem {
  const fields: EntityItem['fields'] = {};
  for (const field of mapping.fields) fields[field] = (record[field] ?? null) as FieldValue;
  return {
    id: String(record.id),
    entity: mapping.entity,
    rev: Number(record.rev),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
    fields,
  };
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
