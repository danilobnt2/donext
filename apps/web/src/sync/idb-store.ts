import type {
  EntityItem,
  FieldValue,
  LocalStore,
  StoreChange,
  StoreSnapshot,
  StoredItem,
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
 * This device's copy of the data, in IndexedDB: each kind in its own object store, plus sync's
 * stores. Every commit is a single transaction, so a crash or an error never leaves it
 * half-written.
 */
export class IdbStore implements LocalStore {
  private readonly storeNames: string[];

  private constructor(
    private readonly db: IDBDatabase,
    private readonly stores: Readonly<Record<string, StoreMapping>>,
  ) {
    this.storeNames = ['sync_meta', 'sync_outbox', ...Object.keys(stores)];
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
    const meta = tx.objectStore('sync_meta');
    const mappings = Object.values(this.stores);
    const [deviceId, cursor, epoch, records, ...kinds] = await Promise.all([
      requestResult(meta.get('deviceId')),
      requestResult(meta.get('cursor')),
      requestResult(meta.get('epoch')),
      requestResult<OutboxRecord[]>(tx.objectStore('sync_outbox').getAll()),
      ...mappings.map((mapping) => requestResult<Row[]>(tx.objectStore(mapping.entity).getAll())),
    ]);
    return {
      deviceId: typeof deviceId === 'string' ? deviceId : null,
      cursor: typeof cursor === 'number' ? cursor : 0,
      epoch: typeof epoch === 'number' ? epoch : null,
      items: kinds.flatMap((rows, index) => rows.map((row) => fromRow(mappings[index]!, row))),
      outbox: records.map((record) => record.op),
    };
  }

  async commit(change: StoreChange): Promise<void> {
    const tx = this.db.transaction(this.storeNames, 'readwrite');
    const done = transactionDone(tx);
    done.catch(() => {}); // reported through the await below, or by the throw that aborted it
    try {
      const meta = tx.objectStore('sync_meta');
      const outbox = tx.objectStore('sync_outbox');

      if (change.deviceId !== undefined) meta.put(change.deviceId, 'deviceId');
      if (change.epoch !== undefined) meta.put(change.epoch, 'epoch');
      if (change.clear) {
        for (const entity of Object.keys(this.stores)) tx.objectStore(entity).clear();
        meta.put(0, 'cursor');
      }
      for (const row of change.changes ?? []) {
        const mapping = this.stores[row.entity];
        if (!mapping) throw new Error(`This device has no store for “${row.entity}”.`);
        const store = tx.objectStore(row.entity);
        const existing = await requestResult<Row | undefined>(store.get(row.id));
        if (existing && Number(existing.seq) >= row.seq) continue;
        if (row.item) store.put(toRow(mapping, { seq: row.seq, item: row.item }));
        else store.delete(row.id);
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

function toRow(mapping: StoreMapping, { seq, item }: StoredItem): Row {
  const row: Row = {
    id: item.id,
    rev: item.rev,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    seq,
  };
  for (const field of mapping.fields) row[field] = item.fields[field] ?? null;
  return row;
}

function fromRow(mapping: StoreMapping, row: Row): StoredItem {
  const fields: EntityItem['fields'] = {};
  for (const field of mapping.fields) fields[field] = (row[field] ?? null) as FieldValue;
  return {
    seq: Number(row.seq),
    item: {
      id: String(row.id),
      entity: mapping.entity,
      rev: Number(row.rev),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      fields,
    },
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
