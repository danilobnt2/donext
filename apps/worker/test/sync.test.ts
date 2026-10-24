import { MAX_OPS_PER_PUSH, TITLE_MAX_LENGTH, TODO_LIMIT } from '@donext/shared';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { SYNC_LIMITS } from '../src/sync-state';
import {
  api,
  board,
  changes,
  create,
  postRaw,
  pull,
  push,
  pushOne,
  remove,
  resetBoard,
  update,
} from './helpers';

const defaults = { ...SYNC_LIMITS };
beforeEach(resetBoard);
afterEach(() => Object.assign(SYNC_LIMITS, defaults));

describe('creating', () => {
  it('creates a To-Do with the device’s id, a trimmed title and state New', async () => {
    const itemId = ulid();
    expect(await pushOne(create('  Cut the lawn ', itemId))).toEqual({
      opId: expect.any(String),
      status: 'applied',
    });
    const page = await changes();
    expect(page.changes).toEqual([
      {
        seq: 1,
        entity: 'todo',
        id: itemId,
        item: {
          id: itemId,
          entity: 'todo',
          rev: 1,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          fields: { title: 'Cut the lawn', state: 'new' },
        },
      },
    ]);
  });

  it.each([
    ['a blank title', { title: '   ' }, 'Title is required.'],
    [
      'an over-long title',
      { title: 'x'.repeat(TITLE_MAX_LENGTH + 1) },
      `Title must be at most ${TITLE_MAX_LENGTH} characters.`,
    ],
    ['no title', {}, 'title is required.'],
    ['a field To-Dos do not have', { title: 'x', colour: 'red' }, 'A To-Do has no field “colour”.'],
    ['a state, which only the server sets', { title: 'x', state: 'done' }, 'state cannot be set.'],
  ])('rejects %s', async (_, fields, message) => {
    expect(await pushOne(create('', ulid(), fields))).toMatchObject({
      status: 'rejected',
      reason: 'invalid_field',
      message,
    });
    expect((await changes()).changes).toEqual([]);
  });

  it('rejects a kind of item nobody defined', async () => {
    const op = { ...create('x'), entity: 'gadget' };
    expect(await pushOne(op)).toMatchObject({ status: 'rejected', reason: 'unknown_entity' });
  });

  it('treats a create for an id that exists as already done', async () => {
    const itemId = ulid();
    await pushOne(create('First', itemId));
    expect(await pushOne(create('Second', itemId))).toMatchObject({ status: 'duplicate' });
    expect((await changes()).changes.map((c) => c.item?.fields.title)).toEqual(['First']);
  });

  it('refuses new To-Dos once the board holds TODO_LIMIT, until one is deleted', async () => {
    await runInDurableObject(board(), (_instance, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO work_items (id, type, title, state, rev, created_at, updated_at, seq)
         SELECT printf('01J9%022d', i), 'todo', 'seed', 'new', 1, '', '', 0 FROM n`,
        TODO_LIMIT,
      );
    });
    expect(await pushOne(create('One too many'))).toMatchObject({
      status: 'rejected',
      reason: 'limit_reached',
      message: 'This board is full.',
    });

    await pushOne(remove(`01J9${'1'.padStart(22, '0')}`));
    expect(await pushOne(create('Room again'))).toMatchObject({ status: 'applied' });
  });
});

describe('updating', () => {
  it('changes the title and bumps the domain revision', async () => {
    const itemId = ulid();
    await pushOne(create('Cut', itemId));
    expect(await pushOne(update(itemId, { title: ' Cut the lawn ' }))).toMatchObject({
      status: 'applied',
    });
    const page = await changes();
    expect(page.changes).toHaveLength(1);
    expect(page.changes[0]).toMatchObject({
      seq: 2,
      item: { rev: 2, fields: { title: 'Cut the lawn', state: 'new' } },
    });
  });

  it('writes nothing for a change that changes nothing', async () => {
    const itemId = ulid();
    await pushOne(create('Cut', itemId));
    expect(await pushOne(update(itemId, { title: 'Cut' }))).toMatchObject({ status: 'applied' });
    expect((await changes()).latestSeq).toBe(1);
  });

  it('rejects an unknown To-Do, a bad title, and a state', async () => {
    const itemId = ulid();
    await pushOne(create('Cut', itemId));
    expect(await pushOne(update(ulid(), { title: 'x' }))).toMatchObject({ reason: 'unknown_item' });
    expect(await pushOne(update(itemId, { title: '' }))).toMatchObject({
      reason: 'invalid_field',
      message: 'Title is required.',
    });
    expect(await pushOne(update(itemId, { state: 'done' }))).toMatchObject({
      reason: 'invalid_field',
    });
  });

  it('lets the later write win when two devices change the same field', async () => {
    const itemId = ulid();
    await pushOne(create('Cut', itemId));
    await push([update(itemId, { title: 'From the laptop' }, 1)], 'laptop');
    await push([update(itemId, { title: 'From the phone' }, 1)], 'phone');
    expect((await changes()).changes[0]?.item).toMatchObject({
      rev: 3,
      fields: { title: 'From the phone' },
    });
  });
});

describe('deleting', () => {
  it('removes the row for good, and tells devices it is gone', async () => {
    const itemId = ulid();
    await pushOne(create('Cut', itemId));
    expect(await pushOne(remove(itemId))).toMatchObject({ status: 'applied' });

    expect((await changes()).changes).toEqual([{ seq: 2, entity: 'todo', id: itemId, item: null }]);
    const rows = await runInDurableObject(board(), (_instance, state) =>
      state.storage.sql.exec('SELECT COUNT(*) AS count FROM work_items').one(),
    );
    expect(rows.count).toBe(0);
  });

  it('accepts deleting what is already gone, without recording it again', async () => {
    const itemId = ulid();
    await pushOne(create('Cut', itemId));
    await pushOne(remove(itemId));
    expect(await pushOne(remove(itemId))).toMatchObject({ status: 'applied' });
    expect(await pushOne(remove(ulid()))).toMatchObject({ status: 'applied' });
    expect((await changes()).latestSeq).toBe(2);
  });

  it('refuses changes to a deleted To-Do', async () => {
    const itemId = ulid();
    await pushOne(create('Cut', itemId));
    await pushOne(remove(itemId));
    expect(await pushOne(update(itemId, { title: 'Late edit' }))).toMatchObject({
      reason: 'unknown_item',
    });
  });
});

describe('retries', () => {
  it('applies a change once, however many times it is sent', async () => {
    const itemId = ulid();
    await pushOne(create('Cut', itemId));
    const rename = update(itemId, { title: 'Renamed' });
    await pushOne(rename);
    await pushOne(update(itemId, { title: 'Renamed again' }));

    // A late copy of the first rename must not undo the second.
    expect(await pushOne(rename)).toMatchObject({ status: 'duplicate' });
    expect((await changes()).changes[0]?.item?.fields.title).toBe('Renamed again');
  });

  it('does not remember a rejected change, so it can be retried', async () => {
    const op = create('');
    expect(await pushOne(op)).toMatchObject({ status: 'rejected' });
    expect(await pushOne(op)).toMatchObject({ status: 'rejected' });
  });
});

describe('a push', () => {
  it('answers each change on its own, so one bad change does not sink the rest', async () => {
    const results = await push([
      create('Good'),
      { kind: 'create', opId: 'bad-op', entity: 'todo', itemId: 'nope', fields: {} },
      'not even an object',
      create('Also good'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['applied', 'rejected', 'rejected', 'applied']);
    expect(results[1]).toMatchObject({ opId: 'bad-op', reason: 'invalid_op' });
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
    expect(await pull()).toEqual({
      resync: false,
      epoch: expect.any(Number),
      changes: [],
      latestSeq: 0,
      hasMore: false,
    });
  });

  it('returns each item once, as it is now, in the order of its last write', async () => {
    const [a, b] = [ulid(), ulid()];
    await push([create('A', a), create('B', b), update(a, { title: 'A again' })]);
    expect((await changes()).changes.map((c) => [c.seq, c.item?.fields.title])).toEqual([
      [2, 'B'],
      [3, 'A again'],
    ]);
  });

  it('mixes changed items and deletions in one order, a page at a time', async () => {
    const ids = [ulid(), ulid(), ulid(), ulid()];
    await push([...ids.map((id, i) => create(`To-Do ${i}`, id)), remove(ids[1]!)]);

    const first = await changes('?limit=2');
    expect(first.changes.map((c) => c.seq)).toEqual([1, 3]);
    expect(first).toMatchObject({ latestSeq: 5, hasMore: true });

    const second = await changes('?after=3&limit=2');
    expect(second.changes.map((c) => [c.seq, c.item === null])).toEqual([
      [4, false],
      [5, true],
    ]);
    expect(second.hasMore).toBe(false);
  });

  it('asks a device to start over once deletions it may have missed are forgotten', async () => {
    SYNC_LIMITS.maxDeletions = 1;
    const ids = [ulid(), ulid(), ulid()];
    await push(ids.map((id, i) => create(`To-Do ${i}`, id)));
    await push([remove(ids[0]!), remove(ids[1]!)]); // seq 4 and 5; the deletion at 4 is forgotten

    expect(await pull('?after=3')).toEqual({ resync: true });
    expect((await pull('?after=4')).resync).toBe(false);
    // A new device needs no deletions at all.
    expect((await changes('?after=0')).changes.map((c) => c.id)).toEqual([ids[2], ids[1]]);
  });

  it('asks a device that is ahead of the server to start over', async () => {
    await pushOne(create('Only one'));
    expect(await pull('?after=40')).toEqual({ resync: true });
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
