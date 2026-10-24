import { SCHEMAS, type EntityItem } from '@donext/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAPPINGS } from '../src/mappings';
import { BASE_COLUMNS, tableRepository, type TableMapping } from '../src/repository';

const NOW = '2026-10-24T10:00:00.000Z';
const A = '01J9ZZZZZZZZZZZZZZZZZZZZZA';
const B = '01J9ZZZZZZZZZZZZZZZZZZZZZB';
const C = '01J9ZZZZZZZZZZZZZZZZZZZZZC';

// A second kind in the same table as To-Dos, to show kinds can share one.
const taskMapping: TableMapping = {
  entity: 'task',
  table: 'work_items',
  discriminator: { column: 'type', value: 'task' },
  columns: { title: 'title', state: 'state' },
};

const item = (entity: string, id: string, title: string, rev = 1): EntityItem => ({
  id,
  entity,
  rev,
  createdAt: NOW,
  updatedAt: NOW,
  fields: { title, state: 'new' },
});

const withSql = <T>(run: (sql: SqlStorage) => T) =>
  runInDurableObject(env.USER_STORE.getByName('repositories'), (_instance, state) =>
    run(state.storage.sql),
  );

beforeEach(() => withSql((sql) => sql.exec('DELETE FROM work_items')));

describe('tableRepository', () => {
  it('stores an item as an ordinary row in its own columns, and reads it back', async () => {
    await withSql((sql) => {
      const todos = tableRepository(sql, MAPPINGS.todo!);
      todos.insert(item('todo', A, 'Cut the lawn'), 7);
      expect(todos.get(A)).toEqual(item('todo', A, 'Cut the lawn'));
      expect(sql.exec('SELECT type, title, state, rev, seq FROM work_items').toArray()).toEqual([
        { type: 'todo', title: 'Cut the lawn', state: 'new', rev: 1, seq: 7 },
      ]);
    });
  });

  it('updates fields, revision, time and sync number, and nothing else', async () => {
    await withSql((sql) => {
      const todos = tableRepository(sql, MAPPINGS.todo!);
      todos.insert(item('todo', A, 'Cut'), 1);
      todos.insert(item('todo', B, 'Other'), 2);
      todos.update(
        { ...item('todo', A, 'Cut the lawn', 2), updatedAt: '2026-10-25T00:00:00.000Z' },
        3,
      );

      expect(todos.get(A)).toEqual({
        ...item('todo', A, 'Cut the lawn', 2),
        updatedAt: '2026-10-25T00:00:00.000Z',
      });
      expect(todos.get(B)).toEqual(item('todo', B, 'Other'));
      expect(todos.changedSince(1, 10).map((change) => [change.seq, change.item.id])).toEqual([
        [2, B],
        [3, A],
      ]);
    });
  });

  it('deletes, and says whether there was anything to delete', async () => {
    await withSql((sql) => {
      const todos = tableRepository(sql, MAPPINGS.todo!);
      todos.insert(item('todo', A, 'Cut'), 1);
      expect(todos.delete(A)).toBe(true);
      expect(todos.delete(A)).toBe(false);
      expect(todos.get(A)).toBeUndefined();
      expect(todos.count()).toBe(0);
    });
  });

  it('lists changes in the order they were written, a page at a time', async () => {
    await withSql((sql) => {
      const todos = tableRepository(sql, MAPPINGS.todo!);
      todos.insert(item('todo', A, 'A'), 5);
      todos.insert(item('todo', B, 'B'), 3);
      todos.insert(item('todo', C, 'C'), 9);
      expect(todos.changedSince(0, 2).map((change) => change.seq)).toEqual([3, 5]);
      expect(todos.changedSince(5, 10).map((change) => change.seq)).toEqual([9]);
    });
  });

  it('keeps kinds that share a table apart', async () => {
    await withSql((sql) => {
      const todos = tableRepository(sql, MAPPINGS.todo!);
      const tasks = tableRepository(sql, taskMapping);
      todos.insert(item('todo', A, 'A to-do'), 1);
      tasks.insert(item('task', B, 'A task'), 2);

      expect(todos.get(B)).toBeUndefined();
      expect(tasks.get(A)).toBeUndefined();
      expect(todos.count()).toBe(1);
      expect(tasks.changedSince(0, 10).map((change) => change.item)).toEqual([
        item('task', B, 'A task'),
      ]);
      expect(tasks.delete(A)).toBe(false);
      tasks.update(item('task', A, 'Hijack', 9), 3);
      expect(todos.get(A)).toEqual(item('todo', A, 'A to-do'));
    });
  });

  it('refuses what its columns cannot hold, and names that are not names', async () => {
    await withSql((sql) => {
      const todos = tableRepository(sql, MAPPINGS.todo!);
      const flagged = { ...item('todo', A, 'x'), fields: { title: 'x', state: true } };
      expect(() => todos.insert(flagged, 1)).toThrow('yes/no fields');
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
        // Reading uses every mapped column, so a wrong name fails here.
        const repository = tableRepository(sql, mapping);
        expect(repository.get('absent')).toBeUndefined();
        expect(repository.changedSince(0, 1)).toEqual([]);
      }
    });
  });
});
