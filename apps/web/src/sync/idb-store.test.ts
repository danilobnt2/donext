import type { EntityItem, SyncOp } from '@donext/shared';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { IdbStore } from './idb-store';

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

    const reopened = await open();
    expect(await reopened.load()).toEqual({
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

    const unstorable = { ...item('bad', 1), notStorable: () => {} };
    await expect(
      store.commit({ put: [item('new', 1), unstorable], addOps: [op('o1')], cursor: 9 }),
    ).rejects.toThrow();

    expect(await store.load()).toMatchObject({
      cursor: 1,
      items: [item('kept', 1)],
      outbox: [],
    });
  });
});
