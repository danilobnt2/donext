/**
 * The shape of this device’s database. Each entry upgrades it by one version and runs once,
 * in order, the first time the app opens with it. Append only: never edit an entry that has
 * shipped, since devices that ran it will not run it again.
 */
export type Migration = (db: IDBDatabase, tx: IDBTransaction) => void;

/**
 * Makes the next sync start from zero. Add this to any migration that adds a kind of data:
 * the revisions of that kind may be behind the cursor of a device that ran an older app, which
 * skipped past them because it had no schema for them.
 */
export function resetCursor(tx: IDBTransaction): void {
  tx.objectStore('meta').put(0, 'cursor');
}

export const MIGRATIONS: readonly Migration[] = [
  (db) => {
    // Sync’s own state: the device id and cursor, and the changes not yet confirmed.
    db.createObjectStore('meta');
    db.createObjectStore('outbox', { autoIncrement: true }).createIndex('opId', 'opId', {
      unique: true,
    });
    // To-Dos.
    db.createObjectStore('todo', { keyPath: 'id' }).createIndex('state', 'state');
  },
];
