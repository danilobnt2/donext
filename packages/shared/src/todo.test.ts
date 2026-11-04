import { describe, expect, it } from 'vitest';
import {
  NOTES_MAX_LENGTH,
  TODO_VERSION_LIMIT,
  applyChange,
  checkDueDate,
  oldestKeptVersion,
  parseCreate,
  parseDeviceMeta,
  parseEdit,
  type TodoData,
} from './todo';

const todo: TodoData = { title: 'Cut the lawn', notes: '', dueDate: null, state: 'new' };

describe('parseCreate', () => {
  it('defaults notes to empty and the due date to none', () => {
    expect(parseCreate({ title: ' Cut the lawn ' })).toEqual({
      ok: true,
      value: { kind: 'create', fields: { title: 'Cut the lawn', notes: '', dueDate: null } },
    });
  });

  it.each([
    [null, 'invalid_change'],
    [[], 'invalid_change'],
    [{}, 'invalid_title'],
    [{ title: 'x', notes: 3 }, 'invalid_notes'],
    [{ title: 'x', notes: 'n'.repeat(NOTES_MAX_LENGTH + 1) }, 'invalid_notes'],
    [{ title: 'x', dueDate: '2026-13-01' }, 'invalid_due_date'],
  ])('rejects %j with %s', (input, code) => {
    expect(parseCreate(input)).toMatchObject({ ok: false, code });
  });
});

describe('parseEdit', () => {
  it('keeps only the fields sent', () => {
    expect(parseEdit({ notes: ' Front only ', dueDate: null })).toEqual({
      ok: true,
      value: { kind: 'edit', fields: { notes: 'Front only', dueDate: null } },
    });
  });

  it('rejects an edit with no fields', () => {
    expect(parseEdit({ deviceId: 'x' })).toMatchObject({ ok: false, code: 'invalid_change' });
  });

  it('rejects a blank title', () => {
    expect(parseEdit({ title: ' ' })).toMatchObject({ ok: false, code: 'invalid_title' });
  });
});

describe('checkDueDate', () => {
  it.each(['2026-02-28', '2028-02-29'])('accepts %s', (date) => {
    expect(checkDueDate(date)).toEqual({ ok: true, value: date });
  });

  it.each(['2026-02-29', '2026-2-01', '2026-02-01T00:00:00Z', 20260201])('rejects %s', (date) => {
    expect(checkDueDate(date).ok).toBe(false);
  });
});

describe('applyChange', () => {
  it('creates a To-Do in state New, with every field changed', () => {
    const change = parseCreate({ title: 'Cut the lawn' });
    if (!change.ok) throw new Error(change.message);
    expect(applyChange(null, change.value)).toEqual({
      ok: true,
      data: todo,
      changedFields: ['title', 'notes', 'dueDate'],
    });
  });

  it('refuses to create a To-Do twice or edit a missing one', () => {
    const create = { kind: 'create', fields: todo } as const;
    expect(applyChange(todo, create)).toMatchObject({ ok: false, code: 'already_exists' });
    const edit = { kind: 'edit', fields: { title: 'x' } } as const;
    expect(applyChange(null, edit)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('reports only the fields whose value changed', () => {
    const edit = {
      kind: 'edit',
      fields: { title: 'Cut the lawn', dueDate: '2026-11-30' },
    } as const;
    expect(applyChange(todo, edit)).toEqual({
      ok: true,
      data: { ...todo, dueDate: '2026-11-30' },
      changedFields: ['dueDate'],
    });
    expect(applyChange(todo, { kind: 'edit', fields: { notes: '' } })).toMatchObject({
      changedFields: [],
    });
  });
});

describe('oldestKeptVersion', () => {
  it('keeps the newest TODO_VERSION_LIMIT versions', () => {
    expect(oldestKeptVersion(1)).toBe(1);
    expect(oldestKeptVersion(TODO_VERSION_LIMIT)).toBe(1);
    expect(oldestKeptVersion(TODO_VERSION_LIMIT + 1)).toBe(2);
  });
});

describe('parseDeviceMeta', () => {
  it('defaults to an unidentified device with no device time', () => {
    expect(parseDeviceMeta({})).toEqual({
      ok: true,
      value: { actor: { kind: 'device', id: null }, deviceChangedAt: null },
    });
  });

  it('reads a device id and a zoned device time', () => {
    const meta = parseDeviceMeta({
      deviceId: '01JC0000000000000000000000',
      deviceChangedAt: '2026-11-04T10:00:00+01:00',
    });
    expect(meta).toEqual({
      ok: true,
      value: {
        actor: { kind: 'device', id: '01JC0000000000000000000000' },
        deviceChangedAt: Date.UTC(2026, 10, 4, 9),
      },
    });
  });

  it.each([{ deviceId: 'phone' }, { deviceChangedAt: '2026-11-04 10:00' }, { deviceChangedAt: 0 }])(
    'rejects %j',
    (input) => {
      expect(parseDeviceMeta(input)).toMatchObject({ ok: false, code: 'invalid_device' });
    },
  );
});
