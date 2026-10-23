import {
  MAX_OPS_PER_PUSH,
  TITLE_MAX_LENGTH,
  TODO_LIMIT,
  type OpResult,
  type PullResponse,
  type PushResponse,
  type SyncOp,
  type TodoChanges,
} from '@donext/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

const api = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`https://donext.test${path}`, init));

const board = () => env.USER_STORE.getByName('shared-board');

// Durable Object storage persists across tests in this file, so start each one empty.
beforeEach(async () => {
  await runInDurableObject(board(), (_instance, state) => {
    state.storage.sql.exec('DELETE FROM work_items');
    state.storage.sql.exec('DELETE FROM work_item_revisions');
    state.storage.sql.exec("DELETE FROM sqlite_sequence WHERE name = 'work_item_revisions'");
  });
});

let counter = 0;
const opId = () => `op-${++counter}`;
const NOW = '2026-10-23T10:00:00.000Z';

const create = (title: string, itemId = ulid()): SyncOp => ({
  kind: 'create_todo',
  opId: opId(),
  itemId,
  title,
  clientChangedAt: NOW,
});

const update = (itemId: string, changes: TodoChanges, baseRev = 1): SyncOp => ({
  kind: 'update_todo',
  opId: opId(),
  itemId,
  baseRev,
  changes,
  clientChangedAt: NOW,
});

const postRaw = (body: unknown) =>
  api('/api/v1/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const push = async (ops: unknown[], deviceId = 'dev-a'): Promise<OpResult[]> => {
  const res = await postRaw({ deviceId, ops });
  expect(res.status).toBe(200);
  return (await res.json<PushResponse>()).results;
};

const pushOne = async (op: SyncOp, deviceId?: string): Promise<OpResult> => {
  const [result] = await push([op], deviceId);
  return result!;
};

const pull = async (query = ''): Promise<PullResponse> => {
  const res = await api(`/api/v1/sync${query}`);
  expect(res.status).toBe(200);
  return res.json<PullResponse>();
};

describe('creating', () => {
  it('creates a To-Do in state New, with the client’s id and a trimmed title', async () => {
    const itemId = ulid();
    const result = await pushOne(create('  Cut the lawn ', itemId));
    expect(result).toMatchObject({ status: 'applied', revision: { seq: 1, itemId, rev: 1 } });
    if (result.status === 'rejected') throw new Error('unexpected rejection');
    expect(result.revision?.todo).toMatchObject({
      id: itemId,
      title: 'Cut the lawn',
      state: 'new',
      rev: 1,
    });
    expect(result.revision?.changedFields).toEqual(['title', 'state']);
  });

  it('applies a create and a later update to it in the same push, in order', async () => {
    const itemId = ulid();
    const results = await push([create('Cut', itemId), update(itemId, { title: 'Cut the lawn' })]);
    expect(results.map((r) => r.status)).toEqual(['applied', 'applied']);
    const { revisions } = await pull();
    expect(revisions.map((r) => [r.seq, r.rev, r.todo.title])).toEqual([
      [1, 1, 'Cut'],
      [2, 2, 'Cut the lawn'],
    ]);
  });

  it('records the device as the source of the change', async () => {
    await pushOne(create('Cut the lawn'), 'phone-1');
    const sources = await runInDurableObject(board(), (_instance, state) =>
      state.storage.sql
        .exec<{ source: string; client_changed_at: string }>(
          'SELECT source, client_changed_at FROM work_item_revisions',
        )
        .toArray(),
    );
    expect(sources).toEqual([{ source: 'app:phone-1', client_changed_at: NOW }]);
  });

  it.each([
    ['a blank title', '   '],
    ['an over-long title', 'x'.repeat(TITLE_MAX_LENGTH + 1)],
  ])('rejects %s', async (_, title) => {
    expect(await pushOne(create(title))).toMatchObject({
      status: 'rejected',
      reason: 'invalid_title',
    });
    expect((await pull()).revisions).toEqual([]);
  });

  it('rejects a second To-Do that reuses an id', async () => {
    const itemId = ulid();
    await pushOne(create('First', itemId));
    expect(await pushOne(create('Second', itemId))).toMatchObject({
      status: 'rejected',
      reason: 'item_exists',
    });
  });

  it('refuses new To-Dos once the board holds TODO_LIMIT, not counting abandoned ones', async () => {
    await runInDurableObject(board(), (_instance, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO work_items (id, type, title, state, rev, created_at, updated_at)
         SELECT printf('seed%022d', i), 'todo', 'seed', 'new', 1, '', '' FROM n`,
        TODO_LIMIT,
      );
    });
    expect(await pushOne(create('One too many'))).toMatchObject({
      status: 'rejected',
      reason: 'todo_limit_reached',
    });

    await runInDurableObject(board(), (_instance, state) => {
      state.storage.sql.exec("UPDATE work_items SET state = 'abandoned' WHERE id LIKE 'seed%1'");
    });
    expect(await pushOne(create('Room again'))).toMatchObject({ status: 'applied' });
  });
});

describe('retries', () => {
  it('applies a change once, however many times it is sent', async () => {
    const op = create('Cut the lawn');
    const first = await pushOne(op);
    const again = await pushOne(op, 'dev-b');
    expect(first.status).toBe('applied');
    expect(again).toMatchObject({ status: 'duplicate' });
    if (first.status === 'rejected' || again.status === 'rejected') throw new Error('rejected');
    expect(again.revision).toEqual(first.revision);
    expect((await pull()).revisions).toHaveLength(1);
  });
});

describe('updating', () => {
  it('changes the title and bumps the revision', async () => {
    const itemId = ulid();
    await pushOne(create('Cut', itemId));
    const result = await pushOne(update(itemId, { title: ' Cut the lawn ' }));
    expect(result).toMatchObject({
      status: 'applied',
      revision: { seq: 2, rev: 2, changedFields: ['title'] },
    });
    const { revisions } = await pull();
    expect(revisions.at(-1)?.todo).toMatchObject({ title: 'Cut the lawn', rev: 2, state: 'new' });
  });

  it('does not record a revision for a change that changes nothing', async () => {
    const itemId = ulid();
    await pushOne(create('Cut', itemId));
    expect(await pushOne(update(itemId, { title: 'Cut' }))).toEqual({
      opId: expect.any(String),
      status: 'applied',
      revision: null,
    });
    expect((await pull()).revisions).toHaveLength(1);
  });

  it('abandons a To-Do', async () => {
    const itemId = ulid();
    await pushOne(create('Cut', itemId));
    const result = await pushOne(update(itemId, { state: 'abandoned' }));
    expect(result).toMatchObject({ revision: { changedFields: ['state'] } });
    expect((await pull()).revisions.at(-1)?.todo.state).toBe('abandoned');
  });

  it('rejects an invalid new title and an unknown To-Do', async () => {
    const itemId = ulid();
    await pushOne(create('Cut', itemId));
    expect(await pushOne(update(itemId, { title: '' }))).toMatchObject({
      reason: 'invalid_title',
    });
    expect(await pushOne(update(ulid(), { title: 'x' }))).toMatchObject({
      reason: 'unknown_item',
    });
  });
});

describe('devices that diverge', () => {
  it('merges changes to different fields, whatever the order', async () => {
    const itemId = ulid();
    await pushOne(create('Cut', itemId));
    // Both devices last saw revision 1 and edited offline.
    await pushOne(update(itemId, { title: 'Cut the lawn' }, 1), 'laptop');
    const result = await pushOne(update(itemId, { state: 'abandoned' }, 1), 'phone');
    expect(result).toMatchObject({ status: 'applied', revision: { rev: 3 } });
    expect((await pull()).revisions.at(-1)?.todo).toMatchObject({
      title: 'Cut the lawn',
      state: 'abandoned',
      rev: 3,
    });
  });

  it('lets the later write win a field and keeps the earlier value in the history', async () => {
    const itemId = ulid();
    await pushOne(create('Cut', itemId));
    await pushOne(update(itemId, { title: 'From the laptop' }, 1), 'laptop');
    await pushOne(update(itemId, { title: 'From the phone' }, 1), 'phone');

    const { revisions } = await pull();
    expect(revisions.map((r) => r.todo.title)).toEqual([
      'Cut',
      'From the laptop',
      'From the phone',
    ]);
    expect(revisions.at(-1)?.todo.rev).toBe(3);
  });

  it('refuses edits to a To-Do abandoned elsewhere, but accepts abandoning it twice', async () => {
    const itemId = ulid();
    await pushOne(create('Cut', itemId));
    await pushOne(update(itemId, { state: 'abandoned' }), 'laptop');

    expect(await pushOne(update(itemId, { title: 'Late edit' }), 'phone')).toMatchObject({
      status: 'rejected',
      reason: 'item_abandoned',
    });
    expect(await pushOne(update(itemId, { state: 'abandoned' }), 'phone')).toMatchObject({
      status: 'applied',
      revision: null,
    });
    expect((await pull()).revisions).toHaveLength(2);
  });
});

describe('a push', () => {
  it('answers each change on its own, so one bad change does not sink the rest', async () => {
    const results = await push([
      create('Good'),
      { kind: 'create_todo', opId: 'bad-op', itemId: 'nope', title: 'x', clientChangedAt: NOW },
      'not even an object',
      create('Also good'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['applied', 'rejected', 'rejected', 'applied']);
    expect(results[1]).toMatchObject({ opId: 'bad-op', reason: 'invalid_op' });
    expect((await pull()).revisions).toHaveLength(2);
  });

  it('accepts an empty push', async () => {
    expect(await push([])).toEqual([]);
  });

  it.each([
    ['malformed JSON', '{nope', 400, 'invalid_json'],
    ['a body that is not an object', '[]', 400, 'invalid_request'],
    ['a missing device id', { ops: [] }, 400, 'invalid_request'],
    [
      'too many changes',
      { deviceId: 'd', ops: new Array(MAX_OPS_PER_PUSH + 1).fill({}) },
      400,
      'invalid_request',
    ],
    [
      'a body over 256 KiB',
      { deviceId: 'd', ops: [], padding: 'y'.repeat(300_000) },
      413,
      'payload_too_large',
    ],
  ])('rejects %s', async (_, body, status, code) => {
    const res = await postRaw(body);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error: { code } });
  });
});

describe('pulling', () => {
  it('starts empty', async () => {
    expect(await pull()).toEqual({ revisions: [], latestSeq: 0, hasMore: false });
  });

  it('returns revisions after a cursor, oldest first, in pages', async () => {
    const ids = [ulid(), ulid(), ulid(), ulid(), ulid()];
    await push(ids.map((id, i) => create(`To-Do ${i}`, id)));

    const first = await pull('?limit=2');
    expect(first.revisions.map((r) => r.seq)).toEqual([1, 2]);
    expect(first).toMatchObject({ latestSeq: 5, hasMore: true });

    const second = await pull('?after=2&limit=2');
    expect(second.revisions.map((r) => r.seq)).toEqual([3, 4]);
    expect(second.hasMore).toBe(true);

    const last = await pull('?after=4&limit=2');
    expect(last.revisions.map((r) => r.seq)).toEqual([5]);
    expect(last.hasMore).toBe(false);
  });

  it('reports a cursor ahead of the server so a client can tell it was reset', async () => {
    await pushOne(create('Only one'));
    expect(await pull('?after=40')).toEqual({ revisions: [], latestSeq: 1, hasMore: false });
  });

  it.each(['?after=-1', '?after=1.5', '?after=abc', '?after=', '?limit=0', '?limit=501'])(
    'rejects the query %s',
    async (query) => {
      const res = await api(`/api/v1/sync${query}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    },
  );
});

describe('/api/v1/sync', () => {
  it('allows only GET and POST', async () => {
    const res = await api('/api/v1/sync', { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, POST');
  });
});
