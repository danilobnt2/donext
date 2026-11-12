import { describe, expect, it } from 'vitest';
import {
  EntityType,
  write,
  type Checked,
  type FieldOf,
  type Meta,
  type Query,
  type Store,
} from './change';
import * as Todos from './todo';

type Entity = Todos.Entity;

/** The simplest Store: every entity in memory. */
class MemoryStore implements Store<Entity> {
  entities = new Map<string, Entity>();
  commits: Entity[][] = [];

  async find<K extends 'todoVersion'>(_kind: K, q: Query<Extract<Entity, { kind: K }>> = {}) {
    const query = q as unknown as Query<Entity>;
    const where = Object.entries(query.where ?? {});
    let found = [...this.entities.values()].filter((e) =>
      where.every(([field, value]) => e[field as keyof Entity] === value),
    );
    const order = query.orderBy;
    if (order) {
      found.sort((a, b) => compare(a[order.field], b[order.field]) * (order.desc ? -1 : 1));
    }
    if (query.limit !== undefined) found = found.slice(0, query.limit);
    return found as Extract<Entity, { kind: K }>[];
  }

  async count<K extends 'todoVersion'>(_kind: K, field?: FieldOf<Extract<Entity, { kind: K }>>) {
    const distinct = field as FieldOf<Entity> | undefined;
    const all = [...this.entities.values()];
    return distinct ? new Set(all.map((e) => e[distinct])).size : all.length;
  }

  async newestPer<K extends 'todoVersion'>(
    _kind: K,
    group: FieldOf<Extract<Entity, { kind: K }>>,
    order: FieldOf<Extract<Entity, { kind: K }>>,
  ) {
    const groupBy = group as FieldOf<Entity>;
    const orderBy = order as FieldOf<Entity>;
    const newest = new Map<unknown, Entity>();
    for (const e of this.entities.values()) {
      const seen = newest.get(e[groupBy]);
      if (!seen || compare(e[orderBy], seen[orderBy]) > 0) newest.set(e[groupBy], e);
    }
    return [...newest.values()].sort((a, b) => compare(b[groupBy], a[groupBy])) as Extract<
      Entity,
      { kind: K }
    >[];
  }

  async commit(entities: Entity[]) {
    this.commits.push(entities);
    for (const e of entities) this.entities.set(e.id, e);
  }
}

function compare(a: unknown, b: unknown): number {
  return a === b ? 0 : (a as number) < (b as number) ? -1 : 1;
}

const meta: Meta = { actor: { kind: 'device' }, deviceChangedAt: null };
const A = '01JC000000000000000000000A';
const B = '01JC000000000000000000000B';

describe('write', () => {
  it('commits what a change produces, and later changes see it', async () => {
    const store = new MemoryStore();
    const create = { op: 'create', todoId: A, title: 'Cut the lawn' } as const;
    expect(await write(Todos.entityType, store, create, meta, 100)).toMatchObject({ ok: true });
    expect(await store.count('todoVersion', 'todoId')).toBe(1);
    expect(await write(Todos.entityType, store, create, meta, 200)).toMatchObject({
      code: 'already_exists',
    });
    expect(store.commits).toHaveLength(1);
  });

  it('commits every entity a change touches together', async () => {
    const store = new MemoryStore();
    // A change that touches two entities, as completing a Task will touch its To-Do.
    class Both extends EntityType<Entity, null, never, null> {
      readonly kind = 'todoVersion';
      async load() {
        return null;
      }
      apply(_c: null, _ch: null, meta: Meta, now: number): Checked<Entity[], never> {
        const create = (todoId: string) => ({ op: 'create', todoId, title: 'Both' }) as const;
        const value = [A, B].flatMap((todoId) => {
          const result = Todos.apply({ exists: false, count: 0 }, create(todoId), meta, now);
          return result.ok ? result.value : [];
        });
        return { ok: true, value };
      }
    }
    await write(new Both(), store, null, meta, 100);
    expect(store.commits).toHaveLength(1);
    expect(await store.newestPer('todoVersion', 'todoId', 'version')).toMatchObject([
      { todoId: B },
      { todoId: A },
    ]);
  });
});
