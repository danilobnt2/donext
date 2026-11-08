import { describe, expect, it } from 'vitest';
import * as Todos from './todo';

const ID = '01JC0000000000000000000000';
const todo: Todos.Entity = {
  kind: 'todo',
  type: 'todo',
  id: ID,
  title: 'Cut the lawn',
  state: 'new',
  rev: 1,
  createdAt: 100,
  updatedAt: 100,
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
  it('reads a trimmed title for the given id', () => {
    expect(Todos.parseCreate({ title: ' Cut the lawn ' }, ID)).toEqual({
      ok: true,
      value: { op: 'create', id: ID, title: 'Cut the lawn' },
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
  const create = { op: 'create', id: ID, title: 'Cut the lawn' } as const;

  it('creates a To-Do in state New, at revision 1', () => {
    expect(Todos.apply({ current: null, count: 0 }, create, 100)).toEqual({
      ok: true,
      value: [todo],
    });
  });

  it('refuses to create a To-Do twice or past LIMIT', () => {
    expect(Todos.apply({ current: todo, count: 1 }, create, 200)).toMatchObject({
      ok: false,
      code: 'already_exists',
    });
    expect(Todos.apply({ current: null, count: Todos.LIMIT }, create, 200)).toMatchObject({
      ok: false,
      code: 'todo_limit_reached',
    });
  });
});
