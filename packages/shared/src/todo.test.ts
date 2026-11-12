import { describe, expect, it } from 'vitest';
import * as Todos from './todo';

const ID = '01JC0000000000000000000000';
const meta = { actor: { kind: 'device' }, deviceChangedAt: null } as const;
const v1: Todos.Entity = {
  kind: 'todoVersion',
  id: `${ID}:1`,
  todoId: ID,
  version: 1,
  createdAt: 100,
  change: 'create',
  changedAt: 100,
  ...meta,
  title: 'Cut the lawn',
  notes: '',
  dueDate: null,
  state: 'new',
};

describe('checkTitle', () => {
  it('trims and accepts a normal title', () => {
    expect(Todos.checkTitle('  Cut the lawn ')).toEqual({ ok: true, title: 'Cut the lawn' });
  });

  it('rejects empty, blank and non-string titles', () => {
    expect(Todos.checkTitle('').ok).toBe(false);
    expect(Todos.checkTitle('   ').ok).toBe(false);
    expect(Todos.checkTitle(42).ok).toBe(false);
    expect(Todos.checkTitle(undefined).ok).toBe(false);
  });

  it('counts code points, not UTF-16 units', () => {
    expect(Todos.checkTitle('🙂'.repeat(Todos.TITLE_MAX_LENGTH)).ok).toBe(true);
    expect(Todos.checkTitle('a'.repeat(Todos.TITLE_MAX_LENGTH + 1)).ok).toBe(false);
  });
});

describe('parseCreate', () => {
  it('reads a trimmed title for the given To-Do', () => {
    expect(Todos.parseCreate({ title: ' Cut the lawn ' }, ID)).toEqual({
      ok: true,
      value: { op: 'create', todoId: ID, title: 'Cut the lawn' },
    });
  });

  it.each([
    [null, 'invalid_change'],
    [[], 'invalid_change'],
    [{}, 'invalid_title'],
    [{ title: ' ' }, 'invalid_title'],
  ])('rejects %j with %s', (input, code) => {
    expect(Todos.parseCreate(input, ID)).toMatchObject({ ok: false, code });
  });
});

describe('apply', () => {
  const create = { op: 'create', todoId: ID, title: 'Cut the lawn' } as const;

  it('creates version 1 of the To-Do, in state New', () => {
    expect(Todos.apply({ exists: false, count: 0 }, create, meta, 100)).toEqual({
      ok: true,
      value: [v1],
    });
  });

  it('refuses to create a To-Do twice or past LIMIT', () => {
    expect(Todos.apply({ exists: true, count: 1 }, create, meta, 200)).toMatchObject({
      ok: false,
      code: 'already_exists',
    });
    expect(Todos.apply({ exists: false, count: Todos.LIMIT }, create, meta, 200)).toMatchObject({
      ok: false,
      code: 'todo_limit_reached',
    });
  });
});
