import { SCHEMAS, type Change, type EntityItem, type SyncOp } from '@donext/shared';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { IdbStore } from './idb-store';
import { MIGRATIONS, restartSync, type Migration } from './migrations';
import { BASE_PROPERTIES, STORES } from './stores';

const NOW = '2026-10-24T10:00:00.000Z';

let factory: IDBFactory;
beforeEach(() => {
  factory = new IDBFactory();
});

const open = () => IdbStore.open('test', factory);

const item = (id: string, title = id, rev = 1): EntityItem => ({
  id,
  entity: 'todo',
  rev,
  createdAt: NOW,
  updatedAt: NOW,
  fields: { title, state: 'new' },
});
const put = (seq: number, value: EntityItem): Change => ({
  seq,
  entity: value.entity,
  id: value.id,
  item: value,
});
const gone = (seq: number, id: string): Change => ({ seq, entity: 'todo', id, item: null });
const op = (opId: string): SyncOp => ({
  kind: 'delete',
  opId,
  entity: 'todo',
  itemId: `item-${opId}`,
});

/** Opens the database as plain IndexedDB, to see what is really stored. */
async function raw<T>(use: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const request = factory.open('test');
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await use(db);
  } finally {
    db.close();
  }
}

const result = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

describe('IdbStore', () => {
  it('starts empty', async () => {
    expect(await (await open()).load()).toEqual({
      deviceId: null,
      cursor: 0,
      epoch: null,
      items: [],
      outbox: [],
    });
  });

  it('keeps everything across a reopen', async () => {
    const store = await open();
    await store.commit({
      deviceId: 'dev-1',
      epoch: 42,
      changes: [put(3, item('a'))],
      addOps: [op('o1')],
      cursor: 4,
    });
    expect(await (await open()).load()).toEqual({
      deviceId: 'dev-1',
      cursor: 4,
      epoch: 42,
      items: [{ seq: 3, item: item('a') }],
      outbox: [op('o1')],
    });
  });

  it('takes a row only if it is newer, and removes deleted ones', async () => {
    const store = await open();
    await store.commit({ changes: [put(5, item('a', 'Five'))] });
    await store.commit({ changes: [put(3, item('a', 'Three')), gone(4, 'a')] });
    expect((await store.load()).items).toEqual([{ seq: 5, item: item('a', 'Five') }]);

    await store.commit({ changes: [gone(6, 'a'), gone(7, 'never-here')] });
    expect((await store.load()).items).toEqual([]);
  });

  it('keeps the outbox in the order changes were added, and drops by operation id', async () => {
    const store = await open();
    await store.commit({ addOps: [op('o3'), op('o1')] });
    await store.commit({ addOps: [op('o2')] });
    await store.commit({ dropOps: ['o1', 'unknown'] });
    expect((await store.load()).outbox.map((o) => o.opId)).toEqual(['o3', 'o2']);
  });

  it('moves the cursor forward only; clearing drops the mirror but keeps the outbox', async () => {
    const store = await open();
    await store.commit({ changes: [put(1, item('a'))], addOps: [op('o1')], cursor: 5 });
    await store.commit({ cursor: 3 });
    expect((await store.load()).cursor).toBe(5);

    await store.commit({ clear: true, epoch: 2 });
    expect(await store.load()).toMatchObject({
      cursor: 0,
      epoch: 2,
      items: [],
      outbox: [op('o1')],
    });
  });

  it('applies a commit entirely or not at all', async () => {
    const store = await open();
    await store.commit({ changes: [put(1, item('kept'))], cursor: 1 });
    const unstorable = { ...item('bad'), createdAt: () => {} } as unknown as EntityItem;
    await expect(
      store.commit({
        changes: [put(2, item('new')), put(3, unstorable)],
        addOps: [op('o1')],
        cursor: 9,
      }),
    ).rejects.toThrow();
    expect(await store.load()).toMatchObject({
      cursor: 1,
      items: [{ item: item('kept') }],
      outbox: [],
    });
  });

  it('refuses a row of a kind it has no store for', async () => {
    const store = await open();
    const stranger = { ...put(1, item('x')), entity: 'gadget' };
    await expect(store.commit({ changes: [stranger] })).rejects.toThrow('no store for “gadget”');
  });
});

describe('how a kind is kept', () => {
  it('as flat records in a store of its own, indexed on what the app looks up', async () => {
    await (await open()).commit({ changes: [put(7, item('a', 'Cut the lawn'))] });
    await raw(async (db) => {
      const todos = db.transaction('todo').objectStore('todo');
      expect(await result(todos.getAll())).toEqual([
        {
          id: 'a',
          rev: 1,
          createdAt: NOW,
          updatedAt: NOW,
          seq: 7,
          title: 'Cut the lawn',
          state: 'new',
        },
      ]);
      expect(await result(todos.index('state').getAllKeys('new'))).toEqual(['a']);
    });
  });

  it('is described by a mapping that covers every kind that syncs, field for field', () => {
    expect(Object.keys(STORES).sort()).toEqual(Object.keys(SCHEMAS).sort());
    for (const [entity, schema] of Object.entries(SCHEMAS)) {
      const mapping = STORES[entity]!;
      expect(mapping.entity).toBe(entity);
      expect([...mapping.fields].sort()).toEqual(Object.keys(schema.fields).sort());
      for (const field of mapping.indexes) expect(mapping.fields).toContain(field);
      for (const field of mapping.fields) expect(BASE_PROPERTIES).not.toContain(field);
    }
  });

  it('exists in the database the migrations build, stores and indexes included', async () => {
    await open();
    await raw(async (db) => {
      expect(db.version).toBe(MIGRATIONS.length);
      expect([...db.objectStoreNames]).toEqual(
        expect.arrayContaining(['sync_meta', 'sync_outbox']),
      );
      for (const mapping of Object.values(STORES)) {
        const store = db.transaction(mapping.entity).objectStore(mapping.entity);
        expect([...store.indexNames].sort()).toEqual([...mapping.indexes].sort());
      }
    });
  });
});

describe('migrations', () => {
  const addNotes: Migration = (db, tx) => {
    db.createObjectStore('note', { keyPath: 'id' });
    restartSync(db, tx);
  };
  const withNotes = { ...STORES, note: { entity: 'note', fields: ['text'], indexes: [] } };

  it('upgrade a device with data, and start its mirror over when a kind is added', async () => {
    const before = await open();
    await before.commit({
      deviceId: 'dev-1',
      epoch: 3,
      changes: [put(4, item('a'))],
      addOps: [op('o1')],
      cursor: 7,
    });

    const after = await IdbStore.open('test', factory, {
      migrations: [...MIGRATIONS, addNotes],
      stores: withNotes,
    });
    const loaded = await after.load();
    // What is the user's own stays: the device, its unsent changes and which server it follows.
    expect(loaded).toMatchObject({ deviceId: 'dev-1', epoch: 3, outbox: [op('o1')] });
    // What came from the server goes, so the next sync brings the new kind with everything else.
    expect(loaded).toMatchObject({ cursor: 0, items: [] });

    const note: EntityItem = { ...item('n1'), entity: 'note', fields: { text: 'Buy milk' } };
    await after.commit({ changes: [put(9, note)] });
    expect((await after.load()).items).toEqual([{ seq: 9, item: note }]);
  });

  it('run once, in order, and not again on later opens', async () => {
    const ran: number[] = [];
    const migrations: Migration[] = [
      (db) => {
        ran.push(1);
        db.createObjectStore('sync_meta');
        db.createObjectStore('sync_outbox', { autoIncrement: true }).createIndex('opId', 'opId');
      },
      () => ran.push(2),
      () => ran.push(3),
    ];
    for (let i = 0; i < 3; i++) await IdbStore.open('order', factory, { migrations, stores: {} });
    expect(ran).toEqual([1, 2, 3]);
  });
});
