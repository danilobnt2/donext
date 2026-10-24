import { SCHEMAS, type EntityItem, type SyncOp } from '@donext/shared';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { IdbStore } from './idb-store';
import { MIGRATIONS, resetCursor, type Migration } from './migrations';
import { BASE_PROPERTIES, STORES } from './stores';

let factory: IDBFactory;
beforeEach(() => {
  factory = new IDBFactory();
});

const open = () => IdbStore.open('test', factory);

const item = (id: string, rev: number, title = id): EntityItem => ({
  id,
  entity: 'todo',
  rev,
  createdAt: '2026-10-23T10:00:00.000Z',
  updatedAt: '2026-10-23T10:00:00.000Z',
  fields: { title, state: 'new' },
});

const op = (opId: string): SyncOp => ({
  kind: 'create',
  opId,
  entity: 'todo',
  itemId: `item-${opId}`,
  fields: { title: opId },
  clientChangedAt: '2026-10-23T10:00:00.000Z',
});

/** Opens the database as plain IndexedDB, to see what is really stored. */
async function raw<T>(use: (db: IDBDatabase) => Promise<T>, name = 'test'): Promise<T> {
  const request = factory.open(name);
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

const all = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

describe('IdbStore', () => {
  it('starts empty', async () => {
    expect(await (await open()).load()).toEqual({
      deviceId: null,
      cursor: 0,
      items: [],
      outbox: [],
    });
  });

  it('keeps everything across a reopen', async () => {
    const store = await open();
    await store.commit({
      deviceId: 'dev-1',
      put: [item('a', 1)],
      addOps: [op('o1')],
      cursor: 4,
    });

    expect(await (await open()).load()).toEqual({
      deviceId: 'dev-1',
      cursor: 4,
      items: [item('a', 1)],
      outbox: [op('o1')],
    });
  });

  it('keeps the outbox in the order changes were added, and drops by operation id', async () => {
    const store = await open();
    await store.commit({ addOps: [op('o3'), op('o1')] });
    await store.commit({ addOps: [op('o2')] });
    expect((await store.load()).outbox.map((o) => o.opId)).toEqual(['o3', 'o1', 'o2']);

    await store.commit({ dropOps: ['o1', 'unknown'] });
    expect((await store.load()).outbox.map((o) => o.opId)).toEqual(['o3', 'o2']);
  });

  it('never replaces an item with an older revision of it', async () => {
    const store = await open();
    await store.commit({ put: [item('a', 3, 'Third')] });
    await store.commit({ put: [item('a', 2, 'Second')] });
    expect((await store.load()).items).toEqual([item('a', 3, 'Third')]);

    await store.commit({ put: [item('a', 3, 'Third again')] });
    expect((await store.load()).items[0]?.fields.title).toBe('Third again');
  });

  it('moves the cursor forward only, and clearing resets it', async () => {
    const store = await open();
    await store.commit({ cursor: 5 });
    await store.commit({ cursor: 3 });
    expect((await store.load()).cursor).toBe(5);

    await store.commit({ clear: true, put: [item('b', 1)], cursor: 2 });
    expect(await store.load()).toMatchObject({ cursor: 2, items: [item('b', 1)] });
  });

  it('applies a commit entirely or not at all', async () => {
    const store = await open();
    await store.commit({ put: [item('kept', 1)], cursor: 1 });

    const unstorable = { ...item('bad', 1), createdAt: () => {} } as unknown as EntityItem;
    await expect(
      store.commit({ put: [item('new', 1), unstorable], addOps: [op('o1')], cursor: 9 }),
    ).rejects.toThrow();

    expect(await store.load()).toMatchObject({ cursor: 1, items: [item('kept', 1)], outbox: [] });
  });

  it('refuses an item of a kind it has no store for, and stores nothing from that commit', async () => {
    const store = await open();
    const stranger = { ...item('x', 1), entity: 'gadget' };
    await expect(store.commit({ put: [item('a', 1), stranger], cursor: 3 })).rejects.toThrow(
      'no store for “gadget”',
    );
    expect(await store.load()).toMatchObject({ cursor: 0, items: [] });
  });
});

describe('how a kind is kept', () => {
  it('as flat records in a store of its own, indexed on the fields the app looks up', async () => {
    const store = await open();
    await store.commit({ put: [item('a', 1, 'Cut the lawn')] });

    await raw(async (db) => {
      const tx = db.transaction('todo', 'readonly');
      const todos = tx.objectStore('todo');
      expect(await all(todos.getAll())).toEqual([
        {
          id: 'a',
          rev: 1,
          createdAt: '2026-10-23T10:00:00.000Z',
          updatedAt: '2026-10-23T10:00:00.000Z',
          title: 'Cut the lawn',
          state: 'new',
        },
      ]);
      expect(await all(todos.index('state').getAllKeys('new'))).toEqual(['a']);
      expect(await all(todos.index('state').getAllKeys('abandoned'))).toEqual([]);
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
      expect([...db.objectStoreNames]).toEqual(expect.arrayContaining(['meta', 'outbox']));
      for (const mapping of Object.values(STORES)) {
        expect([...db.objectStoreNames]).toContain(mapping.entity);
        const store = db.transaction(mapping.entity).objectStore(mapping.entity);
        expect([...store.indexNames].sort()).toEqual([...mapping.indexes].sort());
      }
    });
  });
});

describe('migrations', () => {
  const addNotes: Migration = (db, tx) => {
    db.createObjectStore('note', { keyPath: 'id' });
    resetCursor(tx);
  };
  const withNotes = { ...STORES, note: { entity: 'note', fields: ['text'], indexes: [] } };

  it('upgrade a device that already has data, keeping it and making room for a new kind', async () => {
    const before = await open();
    await before.commit({ deviceId: 'dev-1', put: [item('a', 1)], addOps: [op('o1')], cursor: 7 });

    const after = await IdbStore.open('test', factory, {
      migrations: [...MIGRATIONS, addNotes],
      stores: withNotes,
    });
    const note: EntityItem = {
      id: 'n1',
      entity: 'note',
      rev: 1,
      createdAt: '2026-10-23T10:00:00.000Z',
      updatedAt: '2026-10-23T10:00:00.000Z',
      fields: { text: 'Buy milk' },
    };
    await after.commit({ put: [note] });

    const loaded = await after.load();
    expect(loaded.deviceId).toBe('dev-1');
    expect(loaded.outbox).toEqual([op('o1')]);
    expect(loaded.items).toEqual([item('a', 1), note]);
    // The new kind’s older revisions may lie behind the old cursor, so the next sync starts over.
    expect(loaded.cursor).toBe(0);
  });

  it('run once, in order, and not again on later opens', async () => {
    const ran: number[] = [];
    const migrations: Migration[] = [
      (db) => {
        ran.push(1);
        db.createObjectStore('meta');
        db.createObjectStore('outbox', { autoIncrement: true }).createIndex('opId', 'opId');
      },
      () => ran.push(2),
      () => ran.push(3),
    ];
    for (let i = 0; i < 3; i++) await IdbStore.open('order', factory, { migrations, stores: {} });
    expect(ran).toEqual([1, 2, 3]);
  });
});
