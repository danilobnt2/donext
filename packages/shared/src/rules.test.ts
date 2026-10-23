import { describe, expect, it } from 'vitest';
import type { EntityItem, RuleContext } from './entity';
import { checkCreate, checkUpdate } from './rules';
import { todoSchema } from './todo';
import { folderSchema, noteSchema } from './test-entities';

const NOW = '2026-10-23T10:00:00.000Z';
const FOLDER = '01J9ZZZZZZZZZZZZZZZZZZZZF1';

const folder: EntityItem = {
  id: FOLDER,
  entity: 'folder',
  rev: 1,
  createdAt: NOW,
  updatedAt: NOW,
  fields: { name: 'Home' },
};
const ctx: RuleContext = { get: (id) => (id === FOLDER ? folder : undefined) };

const noteItem = (fields: EntityItem['fields']): EntityItem => ({
  id: '01J9ZZZZZZZZZZZZZZZZZZZZN1',
  entity: 'note',
  rev: 1,
  createdAt: NOW,
  updatedAt: NOW,
  fields: { text: 'Buy milk', folder: null, pinned: null, status: 'open', ...fields },
});

describe('checkCreate', () => {
  it('stores parsed values, fills defaults, and starts leftover fields as null', () => {
    expect(checkCreate(noteSchema, { text: '  Buy milk ' }, ctx)).toEqual({
      ok: true,
      fields: { text: 'Buy milk', folder: null, pinned: null, status: 'open' },
    });
  });

  it.each([
    ['an unknown field', { text: 'x', colour: 'red' }, 'A note has no field “colour”.'],
    ['a missing required field', {}, 'text is required.'],
    [
      'a field only the server writes',
      { text: 'x', status: 'closed' },
      'status cannot be set when creating a note.',
    ],
    ['a bad value', { text: '   ' }, 'Text is required.'],
    ['a wrongly typed value', { text: 'x', pinned: 'yes' }, 'Pinned is yes or no.'],
  ])('refuses %s', (_, input, message) => {
    expect(checkCreate(noteSchema, input, ctx)).toEqual({
      ok: false,
      reason: 'invalid_field',
      message,
    });
  });

  it('lets a rule look at other items', () => {
    expect(checkCreate(noteSchema, { text: 'x', folder: FOLDER }, ctx).ok).toBe(true);
    expect(checkCreate(noteSchema, { text: 'x', folder: 'nowhere' }, ctx)).toEqual({
      ok: false,
      reason: 'rule_violation',
      message: 'The folder does not exist.',
    });
  });

  it('works the same for To-Dos', () => {
    expect(checkCreate(todoSchema, { title: ' Cut the lawn ' }, ctx)).toEqual({
      ok: true,
      fields: { title: 'Cut the lawn', state: 'new' },
    });
    expect(checkCreate(todoSchema, { title: 'x', state: 'done' }, ctx)).toMatchObject({
      reason: 'invalid_field',
    });
    expect(checkCreate(todoSchema, { title: '' }, ctx)).toMatchObject({
      message: 'Title is required.',
    });
  });
});

describe('checkUpdate', () => {
  it('reports only the fields that really change', () => {
    const result = checkUpdate(noteSchema, noteItem({}), { text: ' Buy milk ', pinned: true }, ctx);
    expect(result).toEqual({
      ok: true,
      next: { text: 'Buy milk', folder: null, pinned: true, status: 'open' },
      changedFields: ['pinned'],
    });
  });

  it('accepts a change that changes nothing', () => {
    expect(checkUpdate(noteSchema, noteItem({}), { text: 'Buy milk' }, ctx)).toMatchObject({
      ok: true,
      changedFields: [],
    });
  });

  it.each([
    ['an unknown field', { colour: 'red' }, 'A note has no field “colour”.'],
    ['an immutable field', { folder: FOLDER }, 'folder cannot be changed.'],
    ['a value a device may not write', { status: 'open' }, 'status cannot be set to that value.'],
    ['a bad value', { text: '' }, 'Text is required.'],
  ])('refuses %s', (_, input, message) => {
    expect(checkUpdate(noteSchema, noteItem({}), input, ctx)).toEqual({
      ok: false,
      reason: 'invalid_field',
      message,
    });
  });

  it('finishes an item, and then accepts nothing but the same again', () => {
    const closing = checkUpdate(noteSchema, noteItem({}), { status: 'closed' }, ctx);
    expect(closing).toMatchObject({ ok: true, changedFields: ['status'] });

    const closed = noteItem({ status: 'closed' });
    expect(checkUpdate(noteSchema, closed, { status: 'closed' }, ctx)).toMatchObject({
      ok: true,
      changedFields: [],
    });
    expect(checkUpdate(noteSchema, closed, { text: 'Late edit' }, ctx)).toEqual({
      ok: false,
      reason: 'item_locked',
      message: 'This note is closed.',
    });
    expect(checkUpdate(noteSchema, closed, { status: 'closed', text: 'x' }, ctx).ok).toBe(false);
  });

  it('runs the schema’s own rule on real changes only', () => {
    // A note whose folder has since gone can still be unpinned.
    const orphan = noteItem({ folder: 'gone' });
    expect(checkUpdate(noteSchema, orphan, { pinned: true }, ctx)).toMatchObject({
      reason: 'rule_violation',
    });
    expect(checkUpdate(noteSchema, orphan, { text: 'Buy milk' }, ctx)).toMatchObject({
      ok: true,
      changedFields: [],
    });
  });

  it('works for a kind with other fields', () => {
    expect(checkUpdate(folderSchema, folder, { name: 'Garage' }, ctx)).toMatchObject({
      ok: true,
      changedFields: ['name'],
    });
  });
});
