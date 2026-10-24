import { SCHEMAS, type EntityItem } from '@donext/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAPPINGS } from '../src/mappings';
import { BASE_COLUMNS, tableRepository, type TableMapping } from '../src/repository';

const NOW = '2026-10-23T10:00:00.000Z';

// A second kind in the same table as To-Dos, to show kinds can share one.
const taskMapping: TableMapping = {
  entity: 'task',
  table: 'work_items',
  discriminator: { column: 'type', value: 'task' },
  columns: { title: 'title', state: 'state' },
};

const item = (entity: string, id: string, title: string, state = 'new', rev = 1): EntityItem => ({
  id,
  entity,
  rev,
  createdAt: NOW,
  updatedAt: NOW,
  fields: { title, state },
});

const A = '01J9ZZZZZZZZZZZZZZZZZZZZZA';
const B = '01J9ZZZZZZZZZZZZZZZZZZZZZB';
const C = '01J9ZZZZZZZZZZZZZZZZZZZZZC';

const withSql = <T>(run: (sql: SqlStorage) => T) =>
  runInDurableObject(env.USER_STORE.getByName('repositories'), (_instance, state) =>
    run(state.storage.sql),
  );

beforeEach(() => withSql((sql) => sql.exec('DELETE FROM work_items')));

describe('tableRepository', () => {
  it('stores an item in the kind’s own columns and reads it back', async () => {
    await withSql((sql) => {
      const todos = tableRepository(sql, MAPPINGS.todo!);
      todos.insert(item('todo', A, 'Cut the lawn'));
      expect(todos.get(A)).toEqual(item('todo', A, 'Cut the lawn'));

      // The data is an ordinary row, readable without the sync code.
      expect(sql.exec('SELECT type, title, state, rev FROM work_items').toArray()).toEqual([
        { type: 'todo', title: 'Cut the lawn', state: 'new', rev: 1 },
      ]);
    });
  });

  it('updates fields, revision and time, and nothing else', async () => {
    await withSql((sql) => {
      const todos = tableRepository(sql, MAPPINGS.todo!);
      todos.insert(item('todo', A, 'Cut'));
      todos.insert(item('todo', B, 'Other'));
      todos.update({
        ...item('todo', A, 'Cut the lawn', 'abandoned', 2),
        updatedAt: '2026-10-24T00:00:00.000Z',
      });

      expect(todos.get(A)).toMatchObject({
        rev: 2,
        updatedAt: '2026-10-24T00:00:00.000Z',
        createdAt: NOW,
        fields: { title: 'Cut the lawn', state: 'abandoned' },
      });
      expect(todos.get(B)).toEqual(item('todo', B, 'Other'));
    });
  });

  it('keeps kinds that share a table apart', async () => {
    await withSql((sql) => {
      const todos = tableRepository(sql, MAPPINGS.todo!);
      const tasks = tableRepository(sql, taskMapping);
      todos.insert(item('todo', A, 'A to-do'));
      tasks.insert(item('task', B, 'A task'));
      tasks.insert(item('task', C, 'Another task', 'abandoned'));

      expect(todos.get(B)).toBeUndefined();
      expect(tasks.get(A)).toBeUndefined();
      expect(tasks.get(B)).toEqual(item('task', B, 'A task'));
      expect(todos.count()).toBe(1);
      expect(tasks.count()).toBe(2);
      expect(tasks.count({ field: 'state', value: 'abandoned' })).toBe(1);
      expect(todos.count({ field: 'state', value: 'abandoned' })).toBe(1);

      // Updating one kind never reaches another kind’s row, even with a matching id.
      tasks.update(item('task', A, 'Hijack', 'new', 9));
      expect(todos.get(A)).toEqual(item('todo', A, 'A to-do'));
    });
  });

  it('refuses what its columns cannot hold, and what it was not told about', async () => {
    await withSql((sql) => {
      const todos = tableRepository(sql, MAPPINGS.todo!);
      const withFlag = { ...item('todo', A, 'x'), fields: { title: 'x', state: true } };
      expect(() => todos.insert(withFlag)).toThrow('yes/no fields');
      expect(() => todos.count({ field: 'colour', value: 'red' })).toThrow('no field “colour”');
      expect(() =>
        tableRepository(sql, { ...MAPPINGS.todo!, table: 'work_items; DROP TABLE x' }),
      ).toThrow('not a valid table or column name');
    });
  });
});

describe('the mappings', () => {
  it('cover every kind that syncs, field for field', () => {
    expect(Object.keys(MAPPINGS).sort()).toEqual(Object.keys(SCHEMAS).sort());
    for (const [entity, schema] of Object.entries(SCHEMAS)) {
      const mapping = MAPPINGS[entity]!;
      expect(mapping.entity).toBe(entity);
      expect(Object.keys(mapping.columns).sort()).toEqual(Object.keys(schema.fields).sort());
      for (const column of Object.values(mapping.columns))
        expect(BASE_COLUMNS).not.toContain(column);
    }
  });

  it('name tables and columns that exist', async () => {
    await withSql((sql) => {
      for (const mapping of Object.values(MAPPINGS)) {
        const repository = tableRepository(sql, mapping);
        // Reading and counting use every mapped column, so a wrong name fails here.
        expect(repository.get('absent')).toBeUndefined();
        expect(() => repository.count()).not.toThrow();
        for (const field of Object.keys(mapping.columns)) {
          expect(() => repository.count({ field, value: 'x' })).not.toThrow();
        }
      }
    });
  });
});
