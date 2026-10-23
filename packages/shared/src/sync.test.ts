import { describe, expect, it } from 'vitest';
import { MAX_OPS_PER_PUSH, parseOp, parsePushRequest } from './sync';

const ITEM = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const NOW = '2026-10-23T10:00:00.000Z';

const create = {
  kind: 'create_todo',
  opId: 'op1',
  itemId: ITEM,
  title: 'Cut',
  clientChangedAt: NOW,
};
const update = {
  kind: 'update_todo',
  opId: 'op2',
  itemId: ITEM,
  baseRev: 1,
  changes: { title: 'Cut the lawn' },
  clientChangedAt: NOW,
};

describe('parseOp', () => {
  it('accepts a create and an update', () => {
    expect(parseOp(create)).toEqual({ ok: true, op: create });
    expect(parseOp(update)).toEqual({ ok: true, op: update });
  });

  it('accepts abandoning, alone or with a new title', () => {
    expect(parseOp({ ...update, changes: { state: 'abandoned' } }).ok).toBe(true);
    expect(parseOp({ ...update, changes: { title: 'x', state: 'abandoned' } }).ok).toBe(true);
  });

  it('does not trim or check the title: that is the server’s rule', () => {
    expect(parseOp({ ...create, title: '   ' })).toEqual({
      ok: true,
      op: { ...create, title: '   ' },
    });
  });

  it.each([
    ['a non-object', 'nope'],
    ['an unknown kind', { ...create, kind: 'delete_todo' }],
    ['a missing opId', { ...create, opId: undefined }],
    ['an opId with spaces', { ...create, opId: 'a b' }],
    ['an over-long opId', { ...create, opId: 'x'.repeat(65) }],
    ['a malformed item id', { ...create, itemId: 'not-a-ulid' }],
    ['a lowercase item id', { ...create, itemId: ITEM.toLowerCase() }],
    ['a bad timestamp', { ...create, clientChangedAt: 'yesterday' }],
    ['a non-string title', { ...create, title: 7 }],
    ['a negative baseRev', { ...update, baseRev: -1 }],
    ['a fractional baseRev', { ...update, baseRev: 1.5 }],
    ['empty changes', { ...update, changes: {} }],
    ['unknown changes', { ...update, changes: { notes: 'x' } }],
    ['a non-string new title', { ...update, changes: { title: 3 } }],
    ['a state other than abandoned', { ...update, changes: { state: 'done' } }],
    ['changes that are a list', { ...update, changes: [] }],
  ])('rejects %s', (_, raw) => {
    expect(parseOp(raw).ok).toBe(false);
  });

  it('keeps a usable opId on a malformed op so the server can answer it', () => {
    expect(parseOp({ ...create, itemId: 'bad' })).toEqual({ ok: false, opId: 'op1' });
    expect(parseOp(null)).toEqual({ ok: false, opId: '' });
  });
});

describe('parsePushRequest', () => {
  it('parses each op on its own, so one bad op does not sink the batch', () => {
    const parsed = parsePushRequest({ deviceId: 'dev_1', ops: [create, { kind: 'nope' }, update] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.ops.map((op) => op.ok)).toEqual([true, false, true]);
  });

  it.each([
    ['a non-object body', []],
    ['a missing deviceId', { ops: [] }],
    ['an invalid deviceId', { deviceId: 'a b', ops: [] }],
    ['missing ops', { deviceId: 'dev_1' }],
    ['ops that is not a list', { deviceId: 'dev_1', ops: {} }],
    [
      'too many ops',
      { deviceId: 'dev_1', ops: Array.from({ length: MAX_OPS_PER_PUSH + 1 }, () => create) },
    ],
  ])('rejects %s', (_, body) => {
    expect(parsePushRequest(body).ok).toBe(false);
  });

  it('accepts an empty batch', () => {
    expect(parsePushRequest({ deviceId: 'dev_1', ops: [] })).toEqual({
      ok: true,
      deviceId: 'dev_1',
      ops: [],
    });
  });
});
