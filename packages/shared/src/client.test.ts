import { describe, expect, it, vi } from 'vitest';
import {
  MemoryStore,
  SyncEngine,
  projectItems,
  takeChange,
  ulidTime,
  type StoredItem,
  type Transport,
} from './client';
import type { EntityItem, Schemas } from './entity';
import { checkCreate, checkUpdate } from './rules';
import { SCHEMAS } from './schemas';
import type { Change, OpResult, PullResponse, SyncOp } from './sync';
import { TEST_SCHEMAS } from './test-entities';
import { createTodo, deleteAllTodos, listTodos, renameTodo } from './todos';

const NOW = '2026-10-24T10:00:00.000Z';
const ALL: Schemas = { ...SCHEMAS, ...TEST_SCHEMAS };

let counter = 0;
/** Ids that sort in creation order, shaped like ULIDs. */
const newId = () => `01J9ZZZZZZZZZZZZZZZZ${String(++counter).padStart(6, '0')}`;

/** A stand-in for the server that follows the same protocol, with the same rules. */
function fakeServer() {
  let seq = 0;
  let watermark = 0;
  let epoch = 1;
  const rows = new Map<string, StoredItem>();
  let deletions: Change[] = [];
  const applied = new Set<string>();
  const state = { reachable: true, rejectNext: false, maxDeletions: Infinity, pushes: 0 };
  const ctx = { get: (id: string) => rows.get(id)?.item };
  const reject = (op: SyncOp, message: string): OpResult => ({
    opId: op.opId,
    status: 'rejected',
    reason: 'limit_reached',
    message,
  });

  const decide = (op: SyncOp): OpResult => {
    const ok: OpResult = { opId: op.opId, status: 'applied' };
    if (state.rejectNext) {
      state.rejectNext = false;
      return reject(op, 'This board is full.');
    }
    const schema = ALL[op.entity];
    if (!schema)
      return { opId: op.opId, status: 'rejected', reason: 'unknown_entity', message: 'No.' };
    if (op.kind === 'create') {
      if (rows.has(op.itemId)) return { opId: op.opId, status: 'duplicate' };
      const checked = checkCreate(schema, op.fields, ctx);
      if (!checked.ok)
        return {
          opId: op.opId,
          status: 'rejected',
          reason: checked.reason,
          message: checked.message,
        };
      const item = {
        id: op.itemId,
        entity: op.entity,
        rev: 1,
        createdAt: NOW,
        updatedAt: NOW,
        fields: checked.fields,
      };
      rows.set(op.itemId, { seq: ++seq, item });
      return ok;
    }
    if (op.kind === 'update') {
      const current = rows.get(op.itemId)?.item;
      if (!current)
        return {
          opId: op.opId,
          status: 'rejected',
          reason: 'unknown_item',
          message: 'No such item.',
        };
      const checked = checkUpdate(schema, current, op.changes, ctx);
      if (!checked.ok)
        return {
          opId: op.opId,
          status: 'rejected',
          reason: checked.reason,
          message: checked.message,
        };
      if (checked.changedFields.length > 0) {
        rows.set(op.itemId, {
          seq: ++seq,
          item: { ...current, rev: current.rev + 1, fields: checked.fields },
        });
      }
      return ok;
    }
    if (rows.delete(op.itemId)) {
      deletions.push({ seq: ++seq, entity: op.entity, id: op.itemId, item: null });
      while (deletions.length > state.maxDeletions) watermark = deletions.shift()!.seq;
    }
    return ok;
  };

  const transport: Transport = {
    async push(_deviceId, ops) {
      state.pushes++;
      if (!state.reachable) throw new Error('offline');
      return ops.map((op) => {
        if (applied.has(op.opId)) return { opId: op.opId, status: 'duplicate' };
        const result = decide(op);
        if (result.status === 'applied') applied.add(op.opId);
        return result;
      });
    },
    async pull(after, limit): Promise<PullResponse> {
      if (!state.reachable) throw new Error('offline');
      if (after > seq || (after > 0 && after < watermark)) return { resync: true };
      const all = [
        ...[...rows.values()].map((row) => ({
          seq: row.seq,
          entity: row.item.entity,
          id: row.item.id,
          item: row.item,
        })),
        ...deletions,
      ]
        .filter((change) => change.seq > after)
        .sort((a, b) => a.seq - b.seq);
      return {
        resync: false,
        epoch,
        changes: all.slice(0, limit),
        latestSeq: seq,
        hasMore: all.length > limit,
      };
    },
  };

  return {
    transport,
    state,
    rows,
    /** Puts an item on the server as a newer app would have. */
    add(item: EntityItem) {
      rows.set(item.id, { seq: ++seq, item });
    },
    /** Starts the server's data again from nothing, as a wiped store would. */
    reset() {
      seq = 0;
      watermark = 0;
      epoch++;
      rows.clear();
      deletions = [];
      applied.clear();
    },
  };
}

async function openEngine(server = fakeServer(), store = new MemoryStore()) {
  const engine = await SyncEngine.open({ store, transport: server.transport, schemas: ALL, newId });
  return { engine, server, store };
}

const titles = (engine: SyncEngine) => listTodos(engine).map((todo) => todo.title);
const serverTitles = (server: ReturnType<typeof fakeServer>) =>
  [...server.rows.values()].map((row) => row.item.fields.title).sort();

describe('helpers', () => {
  it('reads the time a ULID was made', () => {
    expect(ulidTime('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('2016-07-30T23:54:10.259Z');
  });

  it('takes a row only if it is newer, and removes deleted ones', () => {
    const item = (title: string): EntityItem => ({
      id: 'a',
      entity: 'todo',
      rev: 1,
      createdAt: NOW,
      updatedAt: NOW,
      fields: { title },
    });
    const mirror = new Map<string, StoredItem>();
    takeChange(mirror, { seq: 5, entity: 'todo', id: 'a', item: item('Five') });
    takeChange(mirror, { seq: 3, entity: 'todo', id: 'a', item: item('Three') });
    expect(mirror.get('a')?.item.fields.title).toBe('Five');
    takeChange(mirror, { seq: 4, entity: 'todo', id: 'a', item: null });
    expect(mirror.has('a')).toBe(true);
    takeChange(mirror, { seq: 6, entity: 'todo', id: 'a', item: null });
    expect(mirror.has('a')).toBe(false);
  });

  it('projects pending changes over the mirror, skipping what the rules would refuse', () => {
    const todo: EntityItem = {
      id: '01J9ZZZZZZZZZZZZZZZZZZZZ01',
      entity: 'todo',
      rev: 2,
      createdAt: NOW,
      updatedAt: NOW,
      fields: { title: 'Mirror', state: 'new' },
    };
    const ops: SyncOp[] = [
      {
        kind: 'create',
        opId: 'c',
        entity: 'todo',
        itemId: '01J9ZZZZZZZZZZZZZZZZZZZZ02',
        fields: { title: ' New ' },
      },
      {
        kind: 'create',
        opId: 'bad',
        entity: 'todo',
        itemId: '01J9ZZZZZZZZZZZZZZZZZZZZ03',
        fields: { title: '' },
      },
      {
        kind: 'update',
        opId: 'u',
        entity: 'todo',
        itemId: todo.id,
        baseRev: 2,
        changes: { title: 'Renamed' },
      },
      { kind: 'delete', opId: 'd', entity: 'todo', itemId: '01J9ZZZZZZZZZZZZZZZZZZZZ02' },
    ];
    const items = projectItems([todo], ops.slice(0, 3), ALL);
    expect([...items.values()].map((item) => item.fields.title)).toEqual(['Renamed', 'New']);
    expect([...projectItems([todo], ops, ALL).keys()]).toEqual([todo.id]);
  });
});

describe('SyncEngine with To-Dos', () => {
  it('shows a new To-Do immediately and keeps it on screen through the sync that confirms it', async () => {
    const { engine, server } = await openEngine();
    const seen: string[][] = [];
    engine.subscribe(() => seen.push(titles(engine)));

    expect((await createTodo(engine, '  Cut the lawn ')).ok).toBe(true);
    expect(titles(engine)).toEqual(['Cut the lawn']);
    expect(engine.status()).toMatchObject({ pending: 1, connected: true });

    expect(await engine.sync()).toEqual({ ok: true });
    expect(engine.status()).toEqual({ pending: 0, syncing: false, connected: true });
    expect(serverTitles(server)).toEqual(['Cut the lawn']);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((shown) => shown.length === 1)).toBe(true);
  });

  it('refuses a bad title without queueing anything', async () => {
    const { engine } = await openEngine();
    expect(await createTodo(engine, '   ')).toEqual({ ok: false, message: 'Title is required.' });
    expect(engine.status().pending).toBe(0);
  });

  it('sends only what the user gave, not the defaults it filled in', async () => {
    const { engine, server } = await openEngine();
    const push = vi.spyOn(server.transport, 'push');
    await createTodo(engine, 'Cut the lawn');
    await engine.sync();
    expect(push.mock.calls[0]?.[1]).toMatchObject([
      { kind: 'create', fields: { title: 'Cut the lawn' } },
    ]);
    const sent = push.mock.calls[0]?.[1][0];
    expect(sent?.kind === 'create' && Object.keys(sent.fields)).toEqual(['title']);
  });

  it('keeps working offline and sends everything when the server is back', async () => {
    const { engine, server } = await openEngine();
    server.state.reachable = false;
    await createTodo(engine, 'Offline one');
    await createTodo(engine, 'Offline two');

    expect((await engine.sync()).ok).toBe(false);
    expect(engine.status()).toEqual({ pending: 2, syncing: false, connected: false });
    expect(titles(engine)).toEqual(['Offline two', 'Offline one']);

    server.state.reachable = true;
    expect((await engine.sync()).ok).toBe(true);
    expect(engine.status()).toEqual({ pending: 0, syncing: false, connected: true });
    expect(serverTitles(server)).toEqual(['Offline one', 'Offline two']);
  });

  it('drops a rejected change, goes back to the server’s version and says why', async () => {
    const { engine, server } = await openEngine();
    server.state.rejectNext = true;
    await createTodo(engine, 'Too many');

    expect((await engine.sync()).ok).toBe(true);
    expect(titles(engine)).toEqual([]);
    expect(engine.status().pending).toBe(0);
    expect(engine.rejections()).toMatchObject([
      { reason: 'limit_reached', op: { fields: { title: 'Too many' } } },
    ]);
    engine.dismissRejection(engine.rejections()[0]!.op.opId);
    expect(engine.rejections()).toEqual([]);
  });

  it('picks up what other devices did', async () => {
    const server = fakeServer();
    const phone = (await openEngine(server)).engine;
    const laptop = (await openEngine(server)).engine;

    await createTodo(phone, 'From the phone');
    await phone.sync();
    await laptop.sync();
    expect(titles(laptop)).toEqual(['From the phone']);

    await renameTodo(laptop, listTodos(laptop)[0]!.id, 'Renamed on the laptop');
    await laptop.sync();
    await phone.sync();
    expect(titles(phone)).toEqual(['Renamed on the laptop']);
  });

  it('deletes for good, everywhere, and refuses late edits to what was deleted', async () => {
    const server = fakeServer();
    const phone = (await openEngine(server)).engine;
    const laptop = (await openEngine(server)).engine;
    await createTodo(phone, 'Cut the lawn');
    await phone.sync();
    await laptop.sync();
    const id = listTodos(laptop)[0]!.id;

    expect(await deleteAllTodos(phone)).toBe(1);
    expect(titles(phone)).toEqual([]);
    await renameTodo(laptop, id, 'Edited offline'); // not sent yet
    await phone.sync();

    await laptop.sync();
    expect(titles(laptop)).toEqual([]);
    expect(laptop.rejections()).toMatchObject([{ reason: 'unknown_item' }]);
    expect(server.rows.size).toBe(0);
  });

  it('starts its mirror over when the server forgot deletions it may have missed', async () => {
    const server = fakeServer();
    server.state.maxDeletions = 1;
    const phone = (await openEngine(server)).engine;
    const tablet = (await openEngine(server)).engine;
    for (const title of ['One', 'Two', 'Three']) await createTodo(phone, title);
    await phone.sync();
    await tablet.sync();

    server.state.reachable = false;
    await createTodo(tablet, 'Made on the tablet offline');
    server.state.reachable = true;
    for (const todo of listTodos(phone).filter((t) => t.title !== 'Three'))
      await phone.delete([todo.id]);
    await phone.sync();

    expect((await tablet.sync()).ok).toBe(true);
    expect(titles(tablet)).toEqual(['Made on the tablet offline', 'Three']);
    expect(serverTitles(server)).toEqual(['Made on the tablet offline', 'Three']);
  });

  it('starts its mirror over when the server’s data started again from nothing', async () => {
    const { engine, server } = await openEngine();
    await createTodo(engine, 'Before the reset');
    await engine.sync();

    server.reset();
    const other = (await openEngine(server)).engine;
    for (const title of ['After one', 'After two', 'After three']) await createTodo(other, title);
    await other.sync();

    await engine.sync();
    expect(titles(engine)).toEqual(['After three', 'After two', 'After one']);
  });

  it('skips kinds of data it has no schema for, and still moves past them', async () => {
    const { engine, server, store } = await openEngine();
    await createTodo(engine, 'Known');
    await engine.sync();
    server.add({
      id: newId(),
      entity: 'gadget',
      rev: 1,
      createdAt: NOW,
      updatedAt: NOW,
      fields: { colour: 'red' },
    });
    const other = (await openEngine(server)).engine;
    await createTodo(other, 'After the unknown kind');
    await other.sync();

    expect((await engine.sync()).ok).toBe(true);
    expect(titles(engine)).toEqual(['After the unknown kind', 'Known']);
    const stored = await store.load();
    expect(stored.items.map((row) => row.item.entity)).toEqual(['todo', 'todo']);
    expect(stored.cursor).toBe(3);
  });

  it('shares one sync between simultaneous calls and still sends changes made during it', async () => {
    const { engine, server } = await openEngine();
    await createTodo(engine, 'First');
    const first = engine.sync();
    expect(engine.sync()).toBe(first);
    await createTodo(engine, 'Made during the sync');
    await first;
    expect(engine.status().pending).toBe(0);
    expect(server.rows.size).toBe(2);
  });

  it('sends a change again if the answer was lost, and the server takes it once', async () => {
    const { engine, server } = await openEngine();
    await createTodo(engine, 'Cut');
    const realPull = server.transport.pull;
    server.transport.pull = async () => {
      throw new Error('lost on the way back');
    };
    expect((await engine.sync()).ok).toBe(false);
    expect(engine.status().pending).toBe(1); // pushed, but not yet confirmed by a pull

    server.transport.pull = realPull;
    expect((await engine.sync()).ok).toBe(true);
    expect(engine.status().pending).toBe(0);
    expect(server.rows.size).toBe(1);
  });

  it('survives a restart with its mirror, outbox and cursor intact', async () => {
    const server = fakeServer();
    const store = new MemoryStore();
    const first = (await openEngine(server, store)).engine;
    await createTodo(first, 'Synced');
    await first.sync();
    server.state.reachable = false;
    await createTodo(first, 'Still waiting');

    const reopened = (await openEngine(server, store)).engine;
    expect(titles(reopened)).toEqual(['Still waiting', 'Synced']);
    expect(reopened.status().pending).toBe(1);
    server.state.reachable = true;
    await reopened.sync();
    expect(server.rows.size).toBe(2);
  });

  it('keeps one device id for good', async () => {
    const store = new MemoryStore();
    const server = fakeServer();
    const push = vi.spyOn(server.transport, 'push');
    const options = { store, transport: server.transport, schemas: ALL, newId };
    await createTodo(await SyncEngine.open(options), 'x');
    await (await SyncEngine.open(options)).sync();
    await createTodo(await SyncEngine.open(options), 'y');
    await (await SyncEngine.open(options)).sync();
    expect(new Set(push.mock.calls.map(([deviceId]) => deviceId)).size).toBe(1);
  });
});

describe('SyncEngine with other kinds of data', () => {
  it('keeps each kind in its own view', async () => {
    const { engine } = await openEngine();
    await engine.create('folder', { name: 'Home' });
    await createTodo(engine, 'Cut the lawn');
    expect(engine.items('folder').map((item) => item.fields.name)).toEqual(['Home']);
    expect(titles(engine)).toEqual(['Cut the lawn']);
  });

  it('lets a rule use an item that has not reached the server, and sends both in order', async () => {
    const { engine, server } = await openEngine();
    const folder = await engine.create('folder', { name: 'Home' });
    if (!folder.ok) throw new Error('refused');
    expect((await engine.create('note', { text: 'Buy milk', folder: folder.id })).ok).toBe(true);
    expect((await engine.sync()).ok).toBe(true);
    expect(engine.rejections()).toEqual([]);
    expect(server.rows.size).toBe(2);
  });

  it('refuses at once what the rules forbid, with their message', async () => {
    const { engine } = await openEngine();
    expect(await engine.create('note', { text: 'Lost', folder: 'nowhere' })).toEqual({
      ok: false,
      message: 'The folder does not exist.',
    });
    const note = await engine.create('note', { text: 'Buy milk' });
    if (!note.ok) throw new Error('refused');
    expect(await engine.update(note.id, { folder: 'x' })).toEqual({
      ok: false,
      message: 'folder cannot be changed.',
    });
    expect(await engine.update(note.id, { pinned: true })).toEqual({ ok: true });
    expect(engine.items('note')[0]?.fields.pinned).toBe(true);
  });

  it('throws for a kind nobody registered: that is a bug, not user input', async () => {
    const { engine } = await openEngine();
    await expect(engine.create('unheardof', {})).rejects.toThrow(
      'There is no schema named “unheardof”.',
    );
  });
});

describe('MemoryStore', () => {
  it('moves the cursor forward only, and clearing resets it but keeps the outbox', async () => {
    const store = new MemoryStore();
    const op: SyncOp = { kind: 'delete', opId: 'd', entity: 'todo', itemId: 'x' };
    await store.commit({ cursor: 5, addOps: [op] });
    await store.commit({ cursor: 3 });
    expect((await store.load()).cursor).toBe(5);
    await store.commit({ clear: true });
    expect(await store.load()).toMatchObject({ cursor: 0, items: [], outbox: [op] });
  });
});
