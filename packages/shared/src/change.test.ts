import { describe, expect, it } from 'vitest';
import {
  VERSION_LIMIT,
  oldestKeptVersion,
  parseDeviceMeta,
  write,
  type Commit,
  type Kind,
  type Store,
} from './change';
import * as Todos from './todo';

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

/** The simplest Store: versions in memory, newest last per item. */
class MemoryStore implements Store<Todos.Version> {
  versions: Todos.Version[] = [];
  commits: Commit<Todos.Version>[][] = [];

  async newest<K extends 'todo'>(_kind: K, id: string) {
    return (this.versions.filter((v) => v.id === id).at(-1) ?? null) as Extract<
      Todos.Version,
      { kind: K }
    > | null;
  }

  async count() {
    return new Set(this.versions.map((v) => v.id)).size;
  }

  async commit(commits: Commit<Todos.Version>[]) {
    this.commits.push(commits);
    for (const { version, keepFrom } of commits) {
      this.versions = this.versions.filter((v) => v.id !== version.id || v.version >= keepFrom);
      this.versions.push(version);
    }
  }
}

const meta = { actor: { kind: 'device', id: null }, deviceChangedAt: null } as const;
const A = '01JC000000000000000000000A';
const B = '01JC000000000000000000000B';
const todoData: Todos.Data = { title: 'Cut the lawn', notes: '', dueDate: null, state: 'new' };

describe('write', () => {
  it('commits the versions a change produces, then reads them back', async () => {
    const store = new MemoryStore();
    const create = Todos.parseCreate({ title: 'Cut the lawn' }, A);
    if (!create.ok) throw new Error(create.message);
    expect(await write(Todos.kind, store, create.value, meta, 100)).toMatchObject({ ok: true });

    const edit = Todos.parseEdit({ notes: 'Front only' }, A);
    if (!edit.ok) throw new Error(edit.message);
    await write(Todos.kind, store, edit.value, meta, 200);
    expect(await store.newest('todo', A)).toMatchObject({
      version: 2,
      data: { notes: 'Front only' },
    });
  });

  it('commits nothing for a rejected change or one that changes nothing', async () => {
    const store = new MemoryStore();
    const edit = { op: 'edit', id: A, fields: { title: 'x' } } as const;
    expect(await write(Todos.kind, store, edit, meta, 100)).toMatchObject({ code: 'not_found' });
    await write(Todos.kind, store, { op: 'create', id: A, fields: todoData }, meta, 100);
    await write(Todos.kind, store, { op: 'edit', id: A, fields: { notes: '' } }, meta, 200);
    expect(store.commits).toHaveLength(1);
  });

  it('commits every item a change touches together, each pruned to VERSION_LIMIT', async () => {
    const store = new MemoryStore();
    // A change that touches two items, as completing a Task will touch its To-Do.
    const both: Kind<Todos.Version, null, never, null> = {
      load: async () => null,
      apply: (_context, _change, _meta, now) => ({
        ok: true,
        value: [A, B].map((id) => ({
          kind: 'todo',
          id,
          version: VERSION_LIMIT + 1,
          createdAt: now,
          change: 'edit',
          changedFields: ['title'],
          changedAt: now,
          ...meta,
          data: todoData,
        })),
      }),
    };
    await write(both, store, null, meta, 100);
    expect(store.commits).toEqual([
      [A, B].map((id) => ({ version: expect.objectContaining({ id }), keepFrom: 2 })),
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
