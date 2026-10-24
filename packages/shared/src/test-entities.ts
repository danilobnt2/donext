import type { EntitySchema, FieldSpec, Schemas } from './entity';

/*
 * Two made-up kinds of data, used only by tests to show that sync and its rules work for more
 * than To-Dos: a folder, and a note that can sit in a folder.
 */

const text: FieldSpec['parse'] = (value) =>
  typeof value === 'string' && value.trim() !== ''
    ? { ok: true, value: value.trim() }
    : { ok: false, message: 'Text is required.' };

export const folderSchema: EntitySchema = {
  name: 'folder',
  label: 'folder',
  fields: { name: { required: true, parse: text } },
};

export const noteSchema: EntitySchema = {
  name: 'note',
  label: 'note',
  fields: {
    text: { required: true, parse: text },
    // Where the note lives: chosen when it is made, never moved.
    folder: {
      writable: 'on-create',
      parse: (value) =>
        value === null || typeof value === 'string'
          ? { ok: true, value }
          : { ok: false, message: 'Folder must be an id.' },
    },
    pinned: {
      default: false,
      parse: (value) =>
        typeof value === 'boolean'
          ? { ok: true, value }
          : { ok: false, message: 'Pinned is yes or no.' },
    },
  },
  limit: { max: 3, message: 'There are too many notes.' },
  validate(next, ctx) {
    const { folder } = next;
    if (typeof folder === 'string' && ctx.get(folder)?.entity !== 'folder') {
      return { message: 'The folder does not exist.' };
    }
    return null;
  },
};

export const TEST_SCHEMAS: Schemas = { folder: folderSchema, note: noteSchema };
