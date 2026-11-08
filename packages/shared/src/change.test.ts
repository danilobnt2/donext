import { describe, expect, it } from 'vitest';
import {
  EntityType,
  VERSION_LIMIT,
  oldestKeptVersion,
  parseDeviceMeta,
  write,
  type Checked,
  type Meta,
  type Store,
} from './change';
import * as Todos from './todo';

/** The simplest Store: every version in memory, appended in order. */
class MemoryStore implements Store<Todos.Entity> {
  versions: Todos.Entity[] = [];
  commits: Todos.Entity[][] = [];

  async get<K extends 'todo'>(_kind: K, id: string) {
    return (this.versions.filter((v) => v.id === id).at(-1) ?? null) as Extract<
      Todos.Entity,
      { kind: K }
    > | null;
  }

  async count() {
    return new Set(this.versions.map((v) => v.id)).size;
  }

  async commit(versions: Todos.Entity[]) {
    this.commits.push(versions);
    for (const version of versions) {
      const keepFrom = oldestKeptVersion(version.version);
      this.versions = this.versions.filter((v) => v.id !== version.id || v.version >= keepFrom);
      this.versions.push(version);
    }
  }
}

const meta: Meta = { actor: { kind: 'device', id: null }, deviceChangedAt: null };
const A = '01JC000000000000000000000A';
const B = '01JC000000000000000000000B';

describe('write', () => {
  it('commits the versions a change produces, then reads the newest back', async () => {
    const store = new MemoryStore();
    const create = Todos.parseCreate({ title: 'Cut the lawn' }, A);
    if (!create.ok) throw new Error(create.message);
    expect(await write(Todos.entityType, store, create.value, meta, 100)).toMatchObject({
      ok: true,
    });
    const edit = Todos.parseEdit({ notes: 'Front only' }, A);
    if (!edit.ok) throw new Error(edit.message);
    await write(Todos.entityType, store, edit.value, meta, 200);
    expect(await store.get('todo', A)).toMatchObject({ version: 2, notes: 'Front only' });
  });

  it('commits nothing for a rejected change or one that changes nothing', async () => {
    const store = new MemoryStore();
    const edit = { op: 'edit', id: A, fields: { title: 'x' } } as const;
    expect(await write(Todos.entityType, store, edit, meta, 100)).toMatchObject({
      code: 'not_found',
    });
    const fields = { title: 'Cut the lawn', notes: '', dueDate: null, state: 'new' } as const;
    await write(Todos.entityType, store, { op: 'create', id: A, fields }, meta, 100);
    await write(Todos.entityType, store, { op: 'edit', id: A, fields: { notes: '' } }, meta, 200);
    expect(store.commits).toHaveLength(1);
  });

  it('commits every item a change touches together', async () => {
    const store = new MemoryStore();
    // A change that touches two items, as completing a Task will touch its To-Do.
    class Both extends EntityType<Todos.Entity, null, never, null> {
      readonly kind = 'todo';
      async load() {
        return null;
      }
      apply(_c: null, _ch: null, meta: Meta, now: number): Checked<Todos.Entity[], never> {
        return {
          ok: true,
          value: [A, B].map((id) => ({
            kind: 'todo',
            id,
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
          })),
        };
      }
    }
    await write(new Both(), store, null, meta, 100);
    expect(store.commits).toEqual([
      [expect.objectContaining({ id: A }), expect.objectContaining({ id: B })],
    ]);
  });
});

describe('oldestKeptVersion', () => {
  it('keeps the newest VERSION_LIMIT versions', () => {
    expect(oldestKeptVersion(1)).toBe(1);
    expect(oldestKeptVersion(VERSION_LIMIT)).toBe(1);
    expect(oldestKeptVersion(VERSION_LIMIT + 1)).toBe(2);
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
