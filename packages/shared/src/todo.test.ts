import { describe, expect, it } from 'vitest';
import * as Todos from './todo';

const todo: Todos.Data = { title: 'Cut the lawn', notes: '', dueDate: null, state: 'new' };

describe('parseCreate', () => {
  it('defaults notes to empty and the due date to none', () => {
    expect(Todos.parseCreate({ title: ' Cut the lawn ' })).toEqual({
      ok: true,
      value: { kind: 'create', fields: { title: 'Cut the lawn', notes: '', dueDate: null } },
    });
  });

  it.each([
    [null, 'invalid_change'],
    [[], 'invalid_change'],
    [{}, 'invalid_title'],
    [{ title: 'x', notes: 3 }, 'invalid_notes'],
    [{ title: 'x', notes: 'n'.repeat(Todos.NOTES_MAX_LENGTH + 1) }, 'invalid_notes'],
    [{ title: 'x', dueDate: '2026-13-01' }, 'invalid_due_date'],
  ])('rejects %j with %s', (input, code) => {
    expect(Todos.parseCreate(input)).toMatchObject({ ok: false, code });
  });
});

describe('parseEdit', () => {
  it('keeps only the fields sent', () => {
    expect(Todos.parseEdit({ notes: ' Front only ', dueDate: null })).toEqual({
      ok: true,
      value: { kind: 'edit', fields: { notes: 'Front only', dueDate: null } },
    });
  });

  it('rejects an edit with no fields', () => {
    expect(Todos.parseEdit({ deviceId: 'x' })).toMatchObject({ ok: false, code: 'invalid_change' });
  });

  it('rejects a blank title', () => {
    expect(Todos.parseEdit({ title: ' ' })).toMatchObject({ ok: false, code: 'invalid_title' });
  });
});

describe('checkDueDate', () => {
  it.each(['2026-02-28', '2028-02-29'])('accepts %s', (date) => {
    expect(Todos.checkDueDate(date)).toEqual({ ok: true, value: date });
  });

  it.each(['2026-02-29', '2026-2-01', '2026-02-01T00:00:00Z', 20260201])('rejects %s', (date) => {
    expect(Todos.checkDueDate(date).ok).toBe(false);
  });
});

describe('applyChange', () => {
  it('creates a To-Do in state New, with every field changed', () => {
    const change = Todos.parseCreate({ title: 'Cut the lawn' });
    if (!change.ok) throw new Error(change.message);
    expect(Todos.applyChange(null, change.value)).toEqual({
      ok: true,
      data: todo,
      changedFields: ['title', 'notes', 'dueDate'],
    });
  });

  it('refuses to create a To-Do twice or edit a missing one', () => {
    const create = { kind: 'create', fields: todo } as const;
    expect(Todos.applyChange(todo, create)).toMatchObject({ ok: false, code: 'already_exists' });
    const edit = { kind: 'edit', fields: { title: 'x' } } as const;
    expect(Todos.applyChange(null, edit)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('reports only the fields whose value changed', () => {
    const edit = {
      kind: 'edit',
      fields: { title: 'Cut the lawn', dueDate: '2026-11-30' },
    } as const;
    expect(Todos.applyChange(todo, edit)).toEqual({
      ok: true,
      data: { ...todo, dueDate: '2026-11-30' },
      changedFields: ['dueDate'],
    });
    expect(Todos.applyChange(todo, { kind: 'edit', fields: { notes: '' } })).toMatchObject({
      changedFields: [],
    });
  });
});

describe('oldestKeptVersion', () => {
  it('keeps the newest Todos.VERSION_LIMIT versions', () => {
    expect(Todos.oldestKeptVersion(1)).toBe(1);
    expect(Todos.oldestKeptVersion(Todos.VERSION_LIMIT)).toBe(1);
    expect(Todos.oldestKeptVersion(Todos.VERSION_LIMIT + 1)).toBe(2);
  });
});

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
