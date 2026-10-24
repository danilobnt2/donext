import { describe, expect, it } from 'vitest';
import { MAX_FIELDS_PER_OP, MAX_OPS_PER_PUSH, parseOp, parsePushRequest } from './sync';

const ITEM = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';

const create = {
  kind: 'create',
  opId: 'op1',
  entity: 'todo',
  itemId: ITEM,
  fields: { title: 'Cut' },
};
const update = {
  kind: 'update',
  opId: 'op2',
  entity: 'todo',
  itemId: ITEM,
  baseRev: 1,
  changes: { title: 'Cut the lawn' },
};
const remove = { kind: 'delete', opId: 'op3', entity: 'todo', itemId: ITEM };

const manyFields = Object.fromEntries(
  Array.from({ length: MAX_FIELDS_PER_OP + 1 }, (_, i) => [`f${i}`, 1]),
);

describe('parseOp', () => {
  it('accepts a create, an update and a delete', () => {
    expect(parseOp(create)).toEqual({ ok: true, op: create });
    expect(parseOp(update)).toEqual({ ok: true, op: update });
    expect(parseOp(remove)).toEqual({ ok: true, op: remove });
  });

  it('keeps only what it knows of an op', () => {
    expect(parseOp({ ...remove, fields: { title: 'x' }, extra: 1 })).toEqual({
      ok: true,
      op: remove,
    });
  });

  it('accepts every kind of plain field value, and a create with no fields', () => {
    const fields = { a: 'text', b: 3, c: true, d: null };
    expect(parseOp({ ...create, fields }).ok).toBe(true);
    expect(parseOp({ ...update, changes: fields }).ok).toBe(true);
    expect(parseOp({ ...create, fields: {} }).ok).toBe(true);
  });

  it('does not check what the fields mean: that is the schema’s job', () => {
    expect(parseOp({ ...create, fields: { title: '   ', whatever: 1 } }).ok).toBe(true);
    expect(parseOp({ ...create, entity: 'unheardof' }).ok).toBe(true);
  });

  it.each([
    ['a non-object', 'nope'],
    ['an unknown kind', { ...create, kind: 'archive' }],
    ['a missing opId', { ...create, opId: undefined }],
    ['an opId with spaces', { ...create, opId: 'a b' }],
    ['an over-long opId', { ...create, opId: 'x'.repeat(65) }],
    ['a malformed item id', { ...create, itemId: 'not-a-ulid' }],
    ['a lowercase item id', { ...create, itemId: ITEM.toLowerCase() }],
    ['a missing entity', { ...remove, entity: undefined }],
    ['an entity name that is not a name', { ...create, entity: 'To Do' }],
    ['fields that are not an object', { ...create, fields: [] }],
    ['a field name that is not a name', { ...create, fields: { 'a b': 1 } }],
    ['a field value that is not plain', { ...create, fields: { a: { b: 1 } } }],
    ['a field value that is not finite', { ...create, fields: { a: Infinity } }],
    ['too many fields', { ...create, fields: manyFields }],
    ['a negative baseRev', { ...update, baseRev: -1 }],
    ['a fractional baseRev', { ...update, baseRev: 1.5 }],
    ['empty changes', { ...update, changes: {} }],
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
    ['too many ops', { deviceId: 'dev_1', ops: new Array(MAX_OPS_PER_PUSH + 1).fill(create) }],
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
