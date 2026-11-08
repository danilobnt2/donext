import { describe, expect, it } from 'vitest';
import * as Todos from './todo';

const ID = '01JC0000000000000000000000';
const todo: Todos.Data = { title: 'Cut the lawn', notes: '', dueDate: null, state: 'new' };
const meta = { actor: { kind: 'device', id: null }, deviceChangedAt: null } as const;
const v1: Todos.Version = {
  kind: 'todo',
  id: ID,
  version: 1,
  createdAt: 100,
  change: 'create',
  changedFields: ['title', 'notes', 'dueDate', 'state'],
  changedAt: 100,
  ...meta,
  data: todo,
};

describe('parseCreate', () => {
  it('defaults notes to empty and the due date to none', () => {
    expect(Todos.parseCreate({ title: ' Cut the lawn ' }, ID)).toEqual({
      ok: true,
      value: {
        op: 'create',
        id: ID,
        fields: { title: 'Cut the lawn', notes: '', dueDate: null, state: 'new' },
      },
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
    expect(Todos.parseCreate(input, ID)).toMatchObject({ ok: false, code });
  });
});

describe('parseEdit', () => {
  it('keeps only the fields sent', () => {
    expect(Todos.parseEdit({ notes: ' Front only ', dueDate: null }, ID)).toEqual({
      ok: true,
      value: { op: 'edit', id: ID, fields: { notes: 'Front only', dueDate: null } },
    });
  });

  it('rejects an edit with no fields', () => {
    expect(Todos.parseEdit({ deviceId: 'x' }, ID)).toMatchObject({
      ok: false,
      code: 'invalid_change',
    });
  });

  it('rejects state: it is not an editable field', () => {
    expect(Todos.parseEdit({ state: 'done' }, ID)).toMatchObject({
      ok: false,
      code: 'invalid_change',
    });
  });

  it('rejects a blank title', () => {
    expect(Todos.parseEdit({ title: ' ' }, ID)).toMatchObject({ ok: false, code: 'invalid_title' });
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

describe('apply', () => {
  const create = { op: 'create', id: ID, fields: todo } as const;

  it('creates version 1 in state New, with every field changed', () => {
    const change = Todos.parseCreate({ title: 'Cut the lawn' }, ID);
    if (!change.ok) throw new Error(change.message);
    expect(Todos.apply({ current: null, count: 0 }, change.value, meta, 100)).toEqual({
      ok: true,
      value: [v1],
    });
  });

  it('refuses to create a To-Do twice, past LIMIT, or edit a missing one', () => {
    expect(Todos.apply({ current: v1, count: 1 }, create, meta, 200)).toMatchObject({
      ok: false,
      code: 'already_exists',
    });
    expect(Todos.apply({ current: null, count: Todos.LIMIT }, create, meta, 200)).toMatchObject({
      ok: false,
      code: 'todo_limit_reached',
    });
    const edit = { op: 'edit', id: ID, fields: { title: 'x' } } as const;
    expect(Todos.apply({ current: null, count: null }, edit, meta, 200)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('appends the next version with only the fields whose value changed', () => {
    const edit = {
      op: 'edit',
      id: ID,
      fields: { title: 'Cut the lawn', dueDate: '2026-11-30' },
    } as const;
    const device = { actor: { kind: 'device', id: ID }, deviceChangedAt: 150 } as const;
    expect(Todos.apply({ current: v1, count: null }, edit, device, 200)).toEqual({
      ok: true,
      value: [
        {
          ...v1,
          ...device,
          version: 2,
          change: 'edit',
          changedFields: ['dueDate'],
          changedAt: 200,
          data: { ...todo, dueDate: '2026-11-30' },
        },
      ],
    });
  });

  it('appends nothing when nothing changes', () => {
    const edit = { op: 'edit', id: ID, fields: { notes: '' } } as const;
    expect(Todos.apply({ current: v1, count: null }, edit, meta, 200)).toEqual({
      ok: true,
      value: [],
    });
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
