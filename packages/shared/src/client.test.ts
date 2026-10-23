import { describe, expect, it, vi } from 'vitest';
import { MemoryStore, SyncEngine, projectTodos, type Transport } from './client';
import type { OpResult, PullResponse, Revision, SyncOp, TodoChanges } from './sync';
import type { Todo } from './todo';

const NOW = '2026-10-23T10:00:00.000Z';

let counter = 0;
/** Ids that sort in creation order, shaped like ULIDs. */
const newId = () => `01J9ZZZZZZZZZZZZZZZZ${String(++counter).padStart(6, '0')}`;

/** A stand-in for the server that is just enough for the engine to talk to. */
function fakeServer() {
  let seq = 0;
  const items = new Map<string, Todo>();
  const revisions: Revision[] = [];
  const answered = new Map<string, OpResult>();
  const state = { reachable: true, pushes: 0, pulls: 0, rejectNext: false };

  const record = (todo: Todo, fields: string[]): Revision => {
    const revision = {
      seq: ++seq,
      itemId: todo.id,
      rev: todo.rev,
      changedAt: NOW,
      changedFields: fields,
      todo,
    };
    revisions.push(revision);
    items.set(todo.id, todo);
    return revision;
  };

  const apply = (op: SyncOp): OpResult => {
    const earlier = answered.get(op.opId);
    if (earlier?.status === 'applied') return { ...earlier, status: 'duplicate' };
    let result: OpResult;
    if (state.rejectNext) {
      state.rejectNext = false;
      result = {
        opId: op.opId,
        status: 'rejected',
        reason: 'todo_limit_reached',
        message: 'This board is full.',
      };
    } else if (op.kind === 'create_todo') {
      const todo: Todo = {
        id: op.itemId,
        title: op.title,
        state: 'new',
        rev: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      result = { opId: op.opId, status: 'applied', revision: record(todo, ['title', 'state']) };
    } else {
      const current = items.get(op.itemId);
      if (!current) {
        result = {
          opId: op.opId,
          status: 'rejected',
          reason: 'unknown_item',
          message: 'No such To-Do.',
        };
      } else {
        const todo: Todo = { ...current, ...op.changes, rev: current.rev + 1 };
        result = {
          opId: op.opId,
          status: 'applied',
          revision: record(todo, Object.keys(op.changes)),
        };
      }
    }
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
    newId,
    now: () => NOW,
  });
  return { engine, server, store };
}

const titles = (engine: SyncEngine) => engine.view().map((todo) => todo.title);

describe('projectTodos', () => {
  const confirmed: Todo = {
    id: '01J9ZZZZZZZZZZZZZZZZZZZZ01',
    title: 'Confirmed',
    state: 'new',
    rev: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const create = (itemId: string, title: string, opId = `op-${itemId}`): SyncOp => ({
    kind: 'create_todo',
    opId,
    itemId,
    title,
    clientChangedAt: NOW,
  });
  const update = (itemId: string, changes: TodoChanges): SyncOp => ({
    kind: 'update_todo',
    opId: `up-${itemId}-${JSON.stringify(changes)}`,
    itemId,
    baseRev: 1,
    changes,
    clientChangedAt: NOW,
  });

  it('shows a pending create at once, newest first', () => {
    const view = projectTodos([confirmed], [create('01J9ZZZZZZZZZZZZZZZZZZZZ02', ' New one ')]);
    expect(view.map((todo) => todo.title)).toEqual(['New one', 'Confirmed']);
    expect(view[0]).toMatchObject({ state: 'new', rev: 0 });
  });

  it('applies pending renames in order and hides abandoned To-Dos', () => {
    const id = confirmed.id;
    expect(
      projectTodos([confirmed], [update(id, { title: 'One' }), update(id, { title: 'Two' })])[0]
        ?.title,
    ).toBe('Two');
    expect(projectTodos([confirmed], [update(id, { state: 'abandoned' })])).toEqual([]);
  });

  it('ignores changes to To-Dos it does not know, which the server will reject', () => {
    expect(
      projectTodos([confirmed], [update('01J9ZZZZZZZZZZZZZZZZZZZZ09', { title: 'x' })]),
    ).toEqual([confirmed]);
  });
});

describe('SyncEngine', () => {
  it('shows a new To-Do immediately and keeps it through the sync that confirms it', async () => {
    const { engine, server } = await openEngine();
    const seen: string[][] = [];
    engine.subscribe(() => seen.push(titles(engine)));

    const created = await engine.createTodo('  Cut the lawn ');
    expect(created.ok).toBe(true);
    expect(titles(engine)).toEqual(['Cut the lawn']);
    expect(engine.status()).toMatchObject({ pending: 1, connected: true });

    expect(await engine.sync()).toEqual({ ok: true });
    expect(engine.status()).toEqual({ pending: 0, syncing: false, connected: true });
    expect(engine.view()[0]).toMatchObject({ title: 'Cut the lawn', rev: 1 });
    expect(server.items.size).toBe(1);
    // The To-Do never leaves the screen while the server confirms it.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((shown) => shown.length === 1)).toBe(true);
  });

  it('refuses a bad title without queueing anything', async () => {
    const { engine } = await openEngine();
    expect(await engine.createTodo('   ')).toEqual({ ok: false, message: 'Title is required.' });
    expect(engine.status().pending).toBe(0);
  });

  it('keeps working offline and sends everything when the server is back', async () => {
    const { engine, server } = await openEngine();
    server.state.reachable = false;
    await engine.createTodo('Offline one');
    await engine.createTodo('Offline two');

    const outcome = await engine.sync();
    expect(outcome.ok).toBe(false);
    expect(engine.status()).toEqual({ pending: 2, syncing: false, connected: false });
    expect(titles(engine)).toEqual(['Offline two', 'Offline one']);

    server.state.reachable = true;
    expect((await engine.sync()).ok).toBe(true);
    expect(engine.status()).toEqual({ pending: 0, syncing: false, connected: true });
    expect([...server.items.values()].map((todo) => todo.title).sort()).toEqual([
      'Offline one',
      'Offline two',
    ]);
  });

  it('drops a rejected change, goes back to the server’s version and says why', async () => {
    const { engine, server } = await openEngine();
    server.state.rejectNext = true;
    await engine.createTodo('Too many');
    expect(titles(engine)).toEqual(['Too many']);

    expect((await engine.sync()).ok).toBe(true);
    expect(titles(engine)).toEqual([]);
    expect(engine.status().pending).toBe(0);
    expect(engine.rejections()).toMatchObject([
      { reason: 'todo_limit_reached', op: { title: 'Too many' } },
    ]);

    engine.dismissRejection(engine.rejections()[0]!.op.opId);
    expect(engine.rejections()).toEqual([]);
  });

  it('picks up what other devices did, once, in order', async () => {
    const server = fakeServer();
    const phone = (await openEngine(server)).engine;
    const laptop = (await openEngine(server)).engine;

    await phone.createTodo('From the phone');
    await phone.sync();
    await laptop.sync();
    expect(titles(laptop)).toEqual(['From the phone']);

    await laptop.renameTodo(laptop.view()[0]!.id, 'Renamed on the laptop');
    await laptop.sync();
    await phone.sync();
    expect(titles(phone)).toEqual(['Renamed on the laptop']);
  });

  it('never replaces a To-Do with an older revision of it', async () => {
    const { engine, server } = await openEngine();
    await engine.createTodo('Original');
    await engine.sync();
    const id = engine.view()[0]!.id;
    await engine.renameTodo(id, 'Renamed');
    await engine.sync();

    // A stale page arriving late, for example from a second tab, must not undo the rename.
    const stale = server.revisions[0]!;
    server.transport.pull = async () => ({ revisions: [stale], latestSeq: 2, hasMore: false });
    await engine.sync();
    expect(titles(engine)).toEqual(['Renamed']);
  });

  it('starts over when the server was reset behind it', async () => {
    const { engine, server } = await openEngine();
    await engine.createTodo('Before the reset');
    await engine.createTodo('Also before the reset');
    await engine.sync();

    server.reset();
    const other = (await openEngine(server)).engine;
    await other.createTodo('After the reset');
    await other.sync();

    await engine.sync();
    expect(titles(engine)).toEqual(['After the reset']);
  });

  it('abandons every visible To-Do', async () => {
    const { engine, server } = await openEngine();
    await engine.createTodo('One');
    await engine.createTodo('Two');
    await engine.sync();

    expect(await engine.abandonAll()).toBe(2);
    expect(titles(engine)).toEqual([]);
    await engine.sync();
    expect([...server.items.values()].map((todo) => todo.state)).toEqual([
      'abandoned',
      'abandoned',
    ]);
    expect(await engine.abandonAll()).toBe(0);
  });

  it('shares one sync between simultaneous calls and still sends changes made during it', async () => {
    const { engine, server } = await openEngine();
    await engine.createTodo('First');

    const first = engine.sync();
    const second = engine.sync();
    expect(second).toBe(first);
    await engine.createTodo('Made during the sync');
    await first;

    expect(engine.status().pending).toBe(0);
    expect(server.items.size).toBe(2);
  });

  it('survives a restart with its outbox and cursor intact', async () => {
    const server = fakeServer();
    const store = new MemoryStore();
    const first = (await openEngine(server, store)).engine;
    await first.createTodo('Synced');
    await first.sync();
    server.state.reachable = false;
    await first.createTodo('Still waiting');

    const reopened = (await openEngine(server, store)).engine;
    expect(titles(reopened)).toEqual(['Still waiting', 'Synced']);
    expect(reopened.status().pending).toBe(1);

    server.state.reachable = true;
    const pulls = server.state.pulls;
    await reopened.sync();
    expect(server.items.size).toBe(2);
    expect(server.state.pulls).toBeGreaterThan(pulls);
  });

  it('keeps one device id for good', async () => {
    const store = new MemoryStore();
    const push = vi.fn<Transport['push']>(async () => []);
    const options = { store, transport: { push, pull: fakeServer().transport.pull }, newId };
    const first = await SyncEngine.open(options);
    await first.createTodo('x');
    await first.sync();
    const second = await SyncEngine.open(options);
    await second.sync();
    const ids = push.mock.calls.map(([deviceId]) => deviceId);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(1);
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
