import { describe, expect, it } from 'vitest';
import { EntityType, write, type Checked, type Store } from './change';
import * as Todos from './todo';

/** The simplest Store: entities in memory. */
class MemoryStore implements Store<Todos.Entity> {
  entities = new Map<string, Todos.Entity>();
  commits: Todos.Entity[][] = [];

  async get<K extends 'todo'>(_kind: K, id: string) {
    return (this.entities.get(id) ?? null) as Extract<Todos.Entity, { kind: K }> | null;
  }

  async count() {
    return this.entities.size;
  }

  async commit(entities: Todos.Entity[]) {
    this.commits.push(entities);
    for (const entity of entities) this.entities.set(entity.id, entity);
  }
}

const A = '01JC000000000000000000000A';
const B = '01JC000000000000000000000B';

describe('write', () => {
  it('commits the entities a change produces', async () => {
    const store = new MemoryStore();
    const create = Todos.parseCreate({ title: 'Cut the lawn' }, A);
    if (!create.ok) throw new Error(create.message);
    expect(await write(Todos.entityType, store, create.value, 100)).toMatchObject({ ok: true });
    expect(await store.get('todo', A)).toMatchObject({ title: 'Cut the lawn', rev: 1 });
  });

  it('commits nothing for a rejected change', async () => {
    const store = new MemoryStore();
    const create = { op: 'create', id: A, title: 'Cut the lawn' } as const;
    await write(Todos.entityType, store, create, 100);
    expect(await write(Todos.entityType, store, create, 200)).toMatchObject({
      code: 'already_exists',
    });
    expect(store.commits).toHaveLength(1);
  });

  it('commits every entity a change touches together', async () => {
    const store = new MemoryStore();
    // A change that touches two entities, as completing a Task will touch its To-Do.
    class Both extends EntityType<Todos.Entity, null, never, null> {
      readonly kind = 'todo';
      async load() {
        return null;
      }
      apply(_context: null, _change: null, now: number): Checked<Todos.Entity[], never> {
        return {
          ok: true,
          value: [A, B].map((id) => ({
            kind: 'todo',
            type: 'todo',
            id,
            title: 'Both',
            state: 'new',
            rev: 1,
            createdAt: now,
            updatedAt: now,
          })),
        };
      }
    }
    const both = new Both();
    await write(both, store, null, 100);
    expect(store.commits).toEqual([
      [expect.objectContaining({ id: A }), expect.objectContaining({ id: B })],
    ]);
  });
});
