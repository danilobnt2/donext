import { describe, expect, it } from 'vitest';
import {
  EntityType,
  parseDeviceMeta,
  write,
  type Checked,
  type FieldOf,
  type Meta,
  type Query,
  type Store,
  type Writes,
} from './change';
import * as Todos from './todo';

type Entity = Todos.Entity;

/** The simplest Store: every entity in memory, for any kind. */
export class MemoryStore implements Store<Entity> {
  entities = new Map<string, Entity>();
  commits: Writes<Entity>[] = [];

  async get<K extends 'todoVersion'>(_kind: K, id: string) {
    return (this.entities.get(id) ?? null) as Extract<Entity, { kind: K }> | null;
  }

  async find<K extends 'todoVersion'>(_kind: K, q: Query<Extract<Entity, { kind: K }>> = {}) {
    const query = q as unknown as Query<Entity>;
    let found = [...this.entities.values()].filter((e) => matches(e, query));
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

  async commit(writes: Writes<Entity>) {
    this.commits.push(writes);
    for (const filter of writes.delete) {
      for (const [id, e] of this.entities) if (matches(e, filter)) this.entities.delete(id);
    }
    for (const e of writes.put) this.entities.set(e.id, e);
  }
}

function matches(e: Entity, { where = {}, before }: Query<Entity>): boolean {
  const equal = Object.entries(where).every(([field, value]) => e[field as keyof Entity] === value);
  return equal && (!before || compare(e[before.field], before.value) < 0);
}

function compare(a: unknown, b: unknown): number {
  return a === b ? 0 : (a as number) < (b as number) ? -1 : 1;
}

const meta: Meta = { actor: { kind: 'device', id: null }, deviceChangedAt: null };
const A = '01JC000000000000000000000A';
const B = '01JC000000000000000000000B';

describe('write', () => {
  it('commits what a change produces, and later changes build on it', async () => {
    const store = new MemoryStore();
    const create = Todos.parseCreate({ title: 'Cut the lawn' }, A);
    if (!create.ok) throw new Error(create.message);
    expect(await write(Todos.entityType, store, create.value, meta, 100)).toMatchObject({
      ok: true,
    });
    const edit = Todos.parseEdit({ notes: 'Front only' }, A);
    if (!edit.ok) throw new Error(edit.message);
    await write(Todos.entityType, store, edit.value, meta, 200);
    expect(await Todos.newest(store, A)).toMatchObject({ version: 2, notes: 'Front only' });
    expect(await store.count('todoVersion')).toBe(2);
    expect(await store.count('todoVersion', 'todoId')).toBe(1);
  });

  it('commits nothing for a rejected change or one that changes nothing', async () => {
    const store = new MemoryStore();
    const edit = { op: 'edit', todoId: A, fields: { title: 'x' } } as const;
    expect(await write(Todos.entityType, store, edit, meta, 100)).toMatchObject({
      code: 'not_found',
    });
    const fields = { title: 'Cut the lawn', notes: '', dueDate: null, state: 'new' } as const;
    await write(Todos.entityType, store, { op: 'create', todoId: A, fields }, meta, 100);
    await write(
      Todos.entityType,
      store,
      { op: 'edit', todoId: A, fields: { notes: '' } },
      meta,
      200,
    );
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
      apply(_c: null, _ch: null, meta: Meta, now: number): Checked<Writes<Entity>, never> {
        const put = [A, B].map((todoId): Entity => ({
          kind: 'todoVersion',
          id: Todos.versionId(todoId, 1),
          todoId,
          version: 1,
          createdAt: now,
          change: 'create',
          changedFields: ['title'],
          changedAt: now,
          ...meta,
          title: 'Both',
          notes: '',
          dueDate: null,
          state: 'new',
        }));
        return { ok: true, value: { put, delete: [] } };
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
