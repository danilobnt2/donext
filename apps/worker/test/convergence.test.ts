import { SyncEngine, MemoryStore, httpTransport, type Todo, type Transport } from '@donext/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

// Several devices make random changes, some while offline, then reconnect. However the changes
// interleave, every device must end up showing exactly what the server holds, and no accepted
// change may be lost.

beforeEach(async () => {
  await runInDurableObject(env.USER_STORE.getByName('shared-board'), (_instance, state) => {
    state.storage.sql.exec('DELETE FROM work_items');
    state.storage.sql.exec('DELETE FROM work_item_revisions');
    state.storage.sql.exec("DELETE FROM sqlite_sequence WHERE name = 'work_item_revisions'");
  });
});

/** A small seeded generator, so a failing run can be replayed. */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Device {
  constructor(
    readonly engine: SyncEngine,
    private readonly link: { online: boolean },
  ) {}

  get online() {
    return this.link.online;
  }

  set online(value: boolean) {
    this.link.online = value;
  }

  static async open(): Promise<Device> {
    const link = { online: true };
    const network = httpTransport((path, init) =>
      exports.default.fetch(new Request(`https://donext.test${path}`, init)),
    );
    const transport: Transport = {
      push: (deviceId, ops) => {
        if (!link.online) throw new Error('offline');
        return network.push(deviceId, ops);
      },
      pull: (after, limit) => {
        if (!link.online) throw new Error('offline');
        return network.pull(after, limit);
      },
    };
    const engine = await SyncEngine.open({ store: new MemoryStore(), transport, newId: ulid });
    return new Device(engine, link);
  }
}

async function serverBoard(): Promise<{ visible: Todo[]; ids: Set<string> }> {
  const network = httpTransport((path, init) =>
    exports.default.fetch(new Request(`https://donext.test${path}`, init)),
  );
  const latest = new Map<string, Todo>();
  for (let after = 0; ;) {
    const page = await network.pull(after, 500);
    for (const revision of page.revisions) {
      if (revision.todo.rev >= (latest.get(revision.itemId)?.rev ?? 0)) {
        latest.set(revision.itemId, revision.todo);
      }
      after = revision.seq;
    }
    if (!page.hasMore) break;
  }
  const visible = [...latest.values()]
    .filter((todo) => todo.state !== 'abandoned')
    .sort((a, b) => (a.id < b.id ? 1 : -1));
  return { visible, ids: new Set(latest.keys()) };
}

describe('devices that work independently', () => {
  it.each([1, 2, 3, 4])('converge on the server’s state (seed %i)', async (seed) => {
    const next = random(seed);
    const pick = <T>(items: readonly T[]): T | undefined =>
      items[Math.floor(next() * items.length)];
    const devices = await Promise.all([Device.open(), Device.open(), Device.open()]);
    const created = new Set<string>();
    let counter = 0;

    for (let step = 0; step < 300; step++) {
      const device = pick(devices)!;
      const { engine } = device;
      const roll = next();
      if (roll < 0.3) {
        const result = await engine.createTodo(`To-Do ${++counter}`);
        if (result.ok) created.add(result.id);
      } else if (roll < 0.5) {
        const target = pick(engine.view());
        if (target) await engine.renameTodo(target.id, `Renamed ${++counter}`);
      } else if (roll < 0.57) {
        const target = pick(engine.view());
        if (target) await engine.abandonTodos([target.id]);
      } else if (roll < 0.62) {
        await engine.abandonTodos(
          engine
            .view()
            .slice(0, 2)
            .map((todo) => todo.id),
        );
      } else if (roll < 0.85) {
        await engine.sync();
      } else {
        device.online = !device.online;
      }
    }

    // Everyone reconnects; a few rounds let each device see the others’ last changes.
    for (const device of devices) device.online = true;
    for (let round = 0; round < 3; round++) {
      for (const { engine } of devices) expect(await engine.sync()).toEqual({ ok: true });
    }

    const server = await serverBoard();
    expect(server.ids.size).toBeGreaterThan(10);
    for (const { engine } of devices) {
      expect(engine.status()).toEqual({ pending: 0, syncing: false, connected: true });
      expect(engine.view()).toEqual(server.visible);
    }

    // Nothing the server accepted went missing: every To-Do made is there unless it was refused.
    const refused = new Set(
      devices.flatMap(({ engine }) =>
        engine.rejections().map((r) => (r.op.kind === 'create_todo' ? r.op.itemId : '')),
      ),
    );
    for (const id of created) expect(refused.has(id) || server.ids.has(id)).toBe(true);
  });
});
