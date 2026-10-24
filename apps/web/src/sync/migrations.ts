/**
 * The shape of this device’s database. Each entry upgrades it by one version and runs once, in
 * order, the first time the app opens with it. Append only: never edit an entry that has
 * shipped, since devices that ran it will not run it again.
 */
export type Migration = (db: IDBDatabase, tx: IDBTransaction) => void;

/**
 * Drops the mirror so the next sync takes everything again from the server; the outbox is
 * kept. Call it from any migration that adds a kind of data: a device that ran an older app
 * skipped that kind's rows and moved its cursor past them.
 */
export function restartSync(db: IDBDatabase, tx: IDBTransaction): void {
  for (const name of db.objectStoreNames) {
    if (!name.startsWith('sync_')) tx.objectStore(name).clear();
  }
  tx.objectStore('sync_meta').put(0, 'cursor');
}

export const MIGRATIONS: readonly Migration[] = [
  (db) => {
    // Sync’s own stores: the device id, cursor and server epoch, and the changes not yet confirmed.
    db.createObjectStore('sync_meta');
    db.createObjectStore('sync_outbox', { autoIncrement: true }).createIndex('opId', 'opId', {
      unique: true,
    });
    // To-Dos.
    db.createObjectStore('todo', { keyPath: 'id' }).createIndex('state', 'state');
  },
];
