import { describe, expect, it } from 'vitest';
import type { EntityItem, RuleContext } from './entity';
import { checkCreate, checkUpdate } from './rules';
import { folderSchema, noteSchema } from './test-entities';
import { todoSchema } from './todo';

const NOW = '2026-10-24T10:00:00.000Z';
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

const note = (fields: EntityItem['fields'] = {}): EntityItem => ({
  id: '01J9ZZZZZZZZZZZZZZZZZZZZN1',
  entity: 'note',
  rev: 1,
  createdAt: NOW,
  updatedAt: NOW,
  fields: { text: 'Buy milk', folder: null, pinned: false, ...fields },
});

describe('checkCreate', () => {
  it('stores parsed values, fills defaults, and starts other fields as null', () => {
    expect(checkCreate(noteSchema, { text: '  Buy milk ' }, ctx)).toEqual({
      ok: true,
      fields: { text: 'Buy milk', folder: null, pinned: false },
    });
  });

  it.each([
    ['an unknown field', { text: 'x', colour: 'red' }, 'A note has no field “colour”.'],
    ['a missing required field', {}, 'text is required.'],
    ['a bad value', { text: '   ' }, 'Text is required.'],
    ['a wrongly typed value', { text: 'x', pinned: 'yes' }, 'Pinned is yes or no.'],
  ])('refuses %s', (_, input, message) => {
    expect(checkCreate(noteSchema, input, ctx)).toEqual({
      ok: false,
      reason: 'invalid_field',
      message,
    });
  });

  it('accepts a field that can only be set on create', () => {
    expect(checkCreate(noteSchema, { text: 'x', folder: FOLDER }, ctx).ok).toBe(true);
  });

  it('lets a rule look at other items', () => {
    expect(checkCreate(noteSchema, { text: 'x', folder: 'nowhere' }, ctx)).toEqual({
      ok: false,
      reason: 'rule_violation',
      message: 'The folder does not exist.',
    });
  });

  it('works the same for To-Dos, whose state only the server sets', () => {
    expect(checkCreate(todoSchema, { title: ' Cut the lawn ' }, ctx)).toEqual({
      ok: true,
      fields: { title: 'Cut the lawn', state: 'new' },
    });
    expect(checkCreate(todoSchema, { title: 'x', state: 'done' }, ctx)).toEqual({
      ok: false,
      reason: 'invalid_field',
      message: 'state cannot be set.',
    });
    expect(checkCreate(todoSchema, { title: '' }, ctx)).toMatchObject({
      message: 'Title is required.',
    });
  });
});

describe('checkUpdate', () => {
  it('reports only the fields that really change', () => {
    expect(checkUpdate(noteSchema, note(), { text: ' Buy milk ', pinned: true }, ctx)).toEqual({
      ok: true,
      fields: { text: 'Buy milk', folder: null, pinned: true },
      changedFields: ['pinned'],
    });
  });

  it('accepts a change that changes nothing', () => {
    expect(checkUpdate(noteSchema, note(), { text: 'Buy milk' }, ctx)).toMatchObject({
      ok: true,
      changedFields: [],
    });
  });

  it.each([
    ['an unknown field', { colour: 'red' }, 'A note has no field “colour”.'],
    ['a field set only on create', { folder: FOLDER }, 'folder cannot be changed.'],
    ['a bad value', { text: '' }, 'Text is required.'],
  ])('refuses %s', (_, input, message) => {
    expect(checkUpdate(noteSchema, note(), input, ctx)).toEqual({
      ok: false,
      reason: 'invalid_field',
      message,
    });
  });

  it('refuses a field only the server sets', () => {
    const todo: EntityItem = { ...note(), entity: 'todo', fields: { title: 'x', state: 'new' } };
    expect(checkUpdate(todoSchema, todo, { state: 'done' }, ctx)).toEqual({
      ok: false,
      reason: 'invalid_field',
      message: 'state cannot be set.',
    });
  });

  it('runs the schema’s own rule on real changes only', () => {
    // A note whose folder has since gone is refused a change, but a no-op is fine.
    const orphan = note({ folder: 'gone' });
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
