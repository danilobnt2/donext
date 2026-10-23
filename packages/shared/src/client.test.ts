import { describe, expect, it, vi } from 'vitest';
import { MemoryStore, SyncEngine, projectItems, visibleItems, type Transport } from './client';
import { isTerminal, type EntityItem, type Fields, type Schemas } from './entity';
import { checkCreate, checkUpdate } from './rules';
import { SCHEMAS } from './schemas';
import { TEST_SCHEMAS } from './test-entities';
import type { OpResult, PullResponse, Revision, SyncOp } from './sync';
import { abandonAllTodos, createTodo, listTodos, renameTodo } from './todos';

const NOW = '2026-10-23T10:00:00.000Z';
const ALL: Schemas = { ...SCHEMAS, ...TEST_SCHEMAS };

let counter = 0;
/** Ids that sort in creation order, shaped like ULIDs. */
const newId = () => `01J9ZZZZZZZZZZZZZZZZ${String(++counter).padStart(6, '0')}`;

/** A stand-in for the server that is just enough for the engine to talk to. */
function fakeServer(schemas: Schemas = ALL) {
  let seq = 0;
  const items = new Map<string, EntityItem>();
  const revisions: Revision[] = [];
  const answered = new Map<string, OpResult>();
  const state = { reachable: true, pushes: 0, pulls: 0, rejectNext: false };
  const ctx = { get: (id: string) => items.get(id) };

  const record = (item: EntityItem, changedFields: string[]): Revision => {
    const revision = {
      seq: ++seq,
      itemId: item.id,
      entity: item.entity,
      rev: item.rev,
      changedAt: NOW,
      changedFields,
      item,
    };
    revisions.push(revision);
    items.set(item.id, item);
    return revision;
  };

  const reject = (
    op: SyncOp,
    reason: 'limit_reached' | 'unknown_item' | 'unknown_entity' | 'item_exists',
    message: string,
  ): OpResult => ({ opId: op.opId, status: 'rejected', reason, message });

  const decide = (op: SyncOp): OpResult => {
    if (state.rejectNext) {
      state.rejectNext = false;
      return reject(op, 'limit_reached', 'This board is full.');
    }
    if (op.kind === 'create') {
      const schema = schemas[op.entity];
      if (!schema) return reject(op, 'unknown_entity', 'No such kind of item.');
      if (items.has(op.itemId)) return reject(op, 'item_exists', 'Already there.');
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
      return {
        opId: op.opId,
        status: 'applied',
        revision: record(item, Object.keys(checked.fields)),
      };
    }
    const current = items.get(op.itemId);
    const schema = current && schemas[current.entity];
    if (!current || !schema) return reject(op, 'unknown_item', 'No such item.');
    const checked = checkUpdate(schema, current, op.changes, ctx);
    if (!checked.ok)
      return {
        opId: op.opId,
        status: 'rejected',
        reason: checked.reason,
        message: checked.message,
      };
    if (checked.changedFields.length === 0)
      return { opId: op.opId, status: 'applied', revision: null };
    const item = { ...current, rev: current.rev + 1, fields: checked.next };
    return { opId: op.opId, status: 'applied', revision: record(item, checked.changedFields) };
  };

  const apply = (op: SyncOp): OpResult => {
    const earlier = answered.get(op.opId);
    if (earlier?.status === 'applied') return { ...earlier, status: 'duplicate' };
    const result = decide(op);
    answered.set(op.opId, result);
    return result;
  };

  const transport: Transport = {
    async push(_deviceId, ops) {
      state.pushes++;
      if (!state.reachable) throw new Error('offline');
      return ops.map(apply);
    },
    async pull(after, limit): Promise<PullResponse> {
      state.pulls++;
      if (!state.reachable) throw new Error('offline');
      const newer = revisions.filter((revision) => revision.seq > after);
      return { revisions: newer.slice(0, limit), latestSeq: seq, hasMore: newer.length > limit };
    },
  };

  return {
    transport,
    state,
    items,
    revisions,
    reset() {
      seq = 0;
      items.clear();
      revisions.length = 0;
      answered.clear();
    },
  };
}

async function openEngine(server = fakeServer(), store = new MemoryStore()) {
  const engine = await SyncEngine.open({
    store,
    transport: server.transport,
    schemas: ALL,
    newId,
    now: () => NOW,
  });
  return { engine, server, store };
}

const titles = (engine: SyncEngine) => listTodos(engine).map((todo) => todo.title);
const names = (engine: SyncEngine, entity: string, field: string) =>
  engine.items(entity).map((item) => item.fields[field]);

describe('projectItems', () => {
  const todo: EntityItem = {
    id: '01J9ZZZZZZZZZZZZZZZZZZZZ01',
    entity: 'todo',
    rev: 2,
    createdAt: NOW,
    updatedAt: NOW,
    fields: { title: 'Confirmed', state: 'new' },
  };
  const create = (itemId: string, fields: Fields, entity = 'todo'): SyncOp => ({
    kind: 'create',
    opId: `op-${itemId}`,
    entity,
    itemId,
    fields,
    clientChangedAt: NOW,
  });
  let n = 0;
  const update = (itemId: string, changes: Fields): SyncOp => ({
    kind: 'update',
    opId: `up-${++n}`,
    itemId,
    baseRev: 1,
    changes,
    clientChangedAt: NOW,
  });
  const view = (confirmed: EntityItem[], outbox: SyncOp[]) =>
    visibleItems(projectItems(confirmed, outbox, ALL).values(), 'todo', ALL).map(
      (item) => item.fields.title,
    );

  it('shows a pending create at once, newest first', () => {
    const items = projectItems(
      [todo],
      [create('01J9ZZZZZZZZZZZZZZZZZZZZ02', { title: ' New one ' })],
      ALL,
    );
    expect(visibleItems(items.values(), 'todo', ALL).map((item) => item.fields.title)).toEqual([
      'New one',
      'Confirmed',
    ]);
    expect(items.get('01J9ZZZZZZZZZZZZZZZZZZZZ02')).toMatchObject({
      rev: 0,
      fields: { state: 'new' },
    });
  });

  it('applies pending changes in order and hides finished items', () => {
    expect(
      view([todo], [update(todo.id, { title: 'One' }), update(todo.id, { title: 'Two' })]),
    ).toEqual(['Two']);
    expect(view([todo], [update(todo.id, { state: 'abandoned' })])).toEqual([]);
  });

  it('keeps finished items out of sight but in the projection, so rules can still see them', () => {
    const items = projectItems([todo], [update(todo.id, { state: 'abandoned' })], ALL);
    expect(isTerminal(ALL.todo, items.get(todo.id)!)).toBe(true);
  });

  it('skips changes the rules would refuse, as the server will', () => {
    expect(view([todo], [update('01J9ZZZZZZZZZZZZZZZZZZZZ09', { title: 'x' })])).toEqual([
      'Confirmed',
    ]);
    expect(view([todo], [update(todo.id, { title: '   ' })])).toEqual(['Confirmed']);
    expect(view([todo], [create('01J9ZZZZZZZZZZZZZZZZZZZZ03', { title: '' })])).toEqual([
      'Confirmed',
    ]);
    expect(
      view([todo], [create('01J9ZZZZZZZZZZZZZZZZZZZZ04', { title: 'x' }, 'unheardof')]),
    ).toEqual(['Confirmed']);
  });
});

describe('SyncEngine with To-Dos', () => {
  it('shows a new To-Do immediately and keeps it through the sync that confirms it', async () => {
    const { engine, server } = await openEngine();
    const seen: string[][] = [];
    engine.subscribe(() => seen.push(titles(engine)));

    expect((await createTodo(engine, '  Cut the lawn ')).ok).toBe(true);
    expect(titles(engine)).toEqual(['Cut the lawn']);
    expect(engine.status()).toMatchObject({ pending: 1, connected: true });

    expect(await engine.sync()).toEqual({ ok: true });
    expect(engine.status()).toEqual({ pending: 0, syncing: false, connected: true });
    expect(listTodos(engine)[0]).toMatchObject({ title: 'Cut the lawn', rev: 1 });
    expect(server.items.size).toBe(1);
    // The To-Do never leaves the screen while the server confirms it.
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
    const op = push.mock.calls[0]?.[1][0];
    expect(op).toMatchObject({ kind: 'create', entity: 'todo', fields: { title: 'Cut the lawn' } });
    expect(op && 'fields' in op && Object.keys(op.fields)).toEqual(['title']);
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
    expect([...server.items.values()].map((item) => item.fields.title).sort()).toEqual([
      'Offline one',
      'Offline two',
    ]);
  });

  it('drops a rejected change, goes back to the server’s version and says why', async () => {
    const { engine, server } = await openEngine();
    server.state.rejectNext = true;
    await createTodo(engine, 'Too many');
    expect(titles(engine)).toEqual(['Too many']);

    expect((await engine.sync()).ok).toBe(true);
    expect(titles(engine)).toEqual([]);
    expect(engine.status().pending).toBe(0);
    expect(engine.rejections()).toMatchObject([
      { reason: 'limit_reached', op: { fields: { title: 'Too many' } } },
    ]);

    engine.dismissRejection(engine.rejections()[0]!.op.opId);
    expect(engine.rejections()).toEqual([]);
  });

  it('picks up what other devices did, once, in order', async () => {
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

  it('never replaces an item with an older revision of it', async () => {
    const { engine, server } = await openEngine();
    await createTodo(engine, 'Original');
    await engine.sync();
    await renameTodo(engine, listTodos(engine)[0]!.id, 'Renamed');
    await engine.sync();

    // A stale page arriving late, for example from a second tab, must not undo the rename.
    const stale = server.revisions[0]!;
    server.transport.pull = async () => ({ revisions: [stale], latestSeq: 2, hasMore: false });
    await engine.sync();
    expect(titles(engine)).toEqual(['Renamed']);
  });

  it('starts over when the server was reset behind it', async () => {
    const { engine, server } = await openEngine();
    await createTodo(engine, 'Before the reset');
    await createTodo(engine, 'Also before the reset');
    await engine.sync();

    server.reset();
    const other = (await openEngine(server)).engine;
    await createTodo(other, 'After the reset');
    await other.sync();

    await engine.sync();
    expect(titles(engine)).toEqual(['After the reset']);
  });

  it('abandons every visible To-Do', async () => {
    const { engine, server } = await openEngine();
    await createTodo(engine, 'One');
    await createTodo(engine, 'Two');
    await engine.sync();

    expect(await abandonAllTodos(engine)).toBe(2);
    expect(titles(engine)).toEqual([]);
    await engine.sync();
    expect([...server.items.values()].map((item) => item.fields.state)).toEqual([
      'abandoned',
      'abandoned',
    ]);
    expect(await abandonAllTodos(engine)).toBe(0);
  });

  it('sends nothing for a change that changes nothing', async () => {
    const { engine } = await openEngine();
    await createTodo(engine, 'Same');
    await engine.sync();
    expect(await renameTodo(engine, listTodos(engine)[0]!.id, ' Same ')).toEqual({ ok: true });
    expect(engine.status().pending).toBe(0);
    expect(await renameTodo(engine, 'nope', 'x')).toEqual({ ok: false, message: 'No such item.' });
  });

  it('shares one sync between simultaneous calls and still sends changes made during it', async () => {
    const { engine, server } = await openEngine();
    await createTodo(engine, 'First');

    const first = engine.sync();
    const second = engine.sync();
    expect(second).toBe(first);
    await createTodo(engine, 'Made during the sync');
    await first;

    expect(engine.status().pending).toBe(0);
    expect(server.items.size).toBe(2);
  });

  it('survives a restart with its outbox and cursor intact', async () => {
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
    expect(server.items.size).toBe(2);
  });

  it('keeps one device id for good', async () => {
    const store = new MemoryStore();
    const push = vi.fn<Transport['push']>(async () => []);
    const options = {
      store,
      transport: { push, pull: fakeServer().transport.pull },
      schemas: ALL,
      newId,
    };
    const first = await SyncEngine.open(options);
    await createTodo(first, 'x');
    await first.sync();
    await (await SyncEngine.open(options)).sync();
    const ids = push.mock.calls.map(([deviceId]) => deviceId);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(1);
  });
});

describe('SyncEngine with other kinds of data', () => {
  it('keeps each kind in its own view', async () => {
    const { engine } = await openEngine();
    await engine.create('folder', { name: 'Home' });
    await createTodo(engine, 'Cut the lawn');
    expect(names(engine, 'folder', 'name')).toEqual(['Home']);
    expect(titles(engine)).toEqual(['Cut the lawn']);
  });

  it('lets a rule use an item that has not reached the server yet, and sends both in order', async () => {
    const { engine, server } = await openEngine();
    const folder = await engine.create('folder', { name: 'Home' });
    if (!folder.ok) throw new Error('folder refused');

    const note = await engine.create('note', { text: 'Buy milk', folder: folder.id });
    expect(note.ok).toBe(true);

    expect((await engine.sync()).ok).toBe(true);
    expect(engine.rejections()).toEqual([]);
    expect(server.items.size).toBe(2);
    expect(names(engine, 'note', 'text')).toEqual(['Buy milk']);
  });

  it('refuses at once what a rule forbids, with its message', async () => {
    const { engine } = await openEngine();
    expect(await engine.create('note', { text: 'Lost', folder: 'nowhere' })).toEqual({
      ok: false,
      message: 'The folder does not exist.',
    });
    expect(await engine.create('note', { text: 'x', status: 'closed' })).toMatchObject({
      ok: false,
    });
    expect(engine.status().pending).toBe(0);
  });

  it('applies the same field rules to every kind', async () => {
    const { engine } = await openEngine();
    const folder = await engine.create('folder', { name: 'Home' });
    const note = await engine.create('note', { text: 'Buy milk' });
    if (!folder.ok || !note.ok) throw new Error('refused');

    expect(await engine.update(note.id, { folder: folder.id })).toEqual({
      ok: false,
      message: 'folder cannot be changed.',
    });
    expect(await engine.update(note.id, { pinned: true })).toEqual({ ok: true });
    expect(engine.items('note')[0]?.fields.pinned).toBe(true);
  });

  it('hides a finished item whatever its kind', async () => {
    const { engine, server } = await openEngine();
    const note = await engine.create('note', { text: 'Buy milk' });
    if (!note.ok) throw new Error('refused');
    await engine.sync();

    await engine.update(note.id, { status: 'closed' });
    expect(engine.items('note')).toEqual([]);
    await engine.sync();
    expect(server.items.get(note.id)?.fields.status).toBe('closed');
    expect(await engine.update(note.id, { text: 'Late edit' })).toEqual({
      ok: false,
      message: 'This note is closed.',
    });
  });

  it('shows what the server refused, whatever the kind', async () => {
    const { engine, server } = await openEngine();
    await engine.create('note', { text: 'One' });
    await engine.sync();

    server.state.rejectNext = true;
    await engine.create('note', { text: 'Two' });
    await engine.sync();

    expect(names(engine, 'note', 'text')).toEqual(['One']);
    expect(engine.rejections()).toMatchObject([
      { reason: 'limit_reached', op: { entity: 'note' } },
    ]);
  });

  it('throws for a kind nobody registered: that is a bug, not user input', async () => {
    const { engine } = await openEngine();
    await expect(engine.create('unheardof', {})).rejects.toThrow(
      'There is no schema named “unheardof”.',
    );
  });
});

describe('MemoryStore', () => {
  it('moves the cursor forward only', async () => {
    const store = new MemoryStore();
    await store.commit({ cursor: 5 });
    await store.commit({ cursor: 3 });
    expect((await store.load()).cursor).toBe(5);
    await store.commit({ clear: true, cursor: 2 });
    expect((await store.load()).cursor).toBe(2);
  });
});
