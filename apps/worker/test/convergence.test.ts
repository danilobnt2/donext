import {
  MemoryStore,
  SCHEMAS,
  SyncEngine,
  createTodo,
  httpTransport,
  listTodos,
  renameTodo,
  takeChange,
  toTodo,
  type StoredItem,
  type Transport,
} from '@donext/shared';
import { exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { SYNC_LIMITS } from '../src/sync-state';
import { resetBoard } from './helpers';

// Several devices make random changes, some while offline, then reconnect. However the changes
// interleave, and even when the server has forgotten deletions and devices must start over,
// every device must end up showing exactly what the server holds, and nothing the server
// accepted may go missing.

const defaults = { ...SYNC_LIMITS };
beforeEach(resetBoard);
afterEach(() => Object.assign(SYNC_LIMITS, defaults));

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

const network = () =>
  httpTransport((path, init) =>
    exports.default.fetch(new Request(`https://donext.test${path}`, init)),
  );

async function openDevice() {
  const link = { online: true };
  const server = network();
  const transport: Transport = {
    push: (deviceId, ops) =>
      link.online ? server.push(deviceId, ops) : Promise.reject(new Error('offline')),
    pull: (after, limit) =>
      link.online ? server.pull(after, limit) : Promise.reject(new Error('offline')),
  };
  const engine = await SyncEngine.open({
    store: new MemoryStore(),
    transport,
    schemas: SCHEMAS,
    newId: ulid,
  });
  return { engine, link };
}

/** The server’s own account of the board, as a new device would see it. */
async function serverTodos() {
  const mirror = new Map<string, StoredItem>();
  for (let after = 0; ;) {
    const page = await network().pull(after, 500);
    if (page.resync) throw new Error('a new device was asked to resync');
    for (const change of page.changes) takeChange(mirror, change);
    after = page.changes.at(-1)?.seq ?? after;
    if (!page.hasMore) break;
  }
  return [...mirror.values()]
    .map((row) => row.item)
    .sort((a, b) => (a.id < b.id ? 1 : -1))
    .map(toTodo);
}

describe('devices that work independently', () => {
  it.each([
    [1, defaults.maxDeletions],
    [2, defaults.maxDeletions],
    [3, 5],
    [4, 3],
  ])(
    'converge on the server’s state (seed %i, remembering %s deletions)',
    async (seed, maxDeletions) => {
      SYNC_LIMITS.maxDeletions = maxDeletions;
      const next = random(seed);
      const pick = <T>(items: readonly T[]): T | undefined =>
        items[Math.floor(next() * items.length)];
      const devices = await Promise.all([openDevice(), openDevice(), openDevice()]);
      const created = new Set<string>();
      const deleted = new Set<string>();
      let counter = 0;

      for (let step = 0; step < 300; step++) {
        const device = pick(devices)!;
        const { engine } = device;
        const roll = next();
        if (roll < 0.35) {
          const result = await createTodo(engine, `To-Do ${++counter}`);
          if (result.ok) created.add(result.id);
        } else if (roll < 0.55) {
          const target = pick(listTodos(engine));
          if (target) await renameTodo(engine, target.id, `Renamed ${++counter}`);
        } else if (roll < 0.65) {
          const targets = listTodos(engine)
            .slice(0, 1 + Math.floor(next() * 2))
            .map((todo) => todo.id);
          targets.forEach((id) => deleted.add(id));
          await engine.delete(targets);
        } else if (roll < 0.85) {
          await engine.sync();
        } else {
          device.link.online = !device.link.online;
        }
      }

      // Everyone reconnects; a few rounds let each device see the others’ last changes.
      for (const device of devices) device.link.online = true;
      for (let round = 0; round < 3; round++) {
        for (const { engine } of devices) expect(await engine.sync()).toEqual({ ok: true });
      }

      const server = await serverTodos();
      expect(created.size).toBeGreaterThan(50);
      for (const { engine } of devices) {
        expect(engine.status()).toEqual({ pending: 0, syncing: false, connected: true });
        expect(listTodos(engine)).toEqual(server);
      }

      // Every To-Do made is still there, unless someone deleted it or the server refused it.
      const onServer = new Set(server.map((todo) => todo.id));
      const refused = new Set(
        devices.flatMap(({ engine }) => engine.rejections().map((r) => r.op.itemId)),
      );
      for (const id of created) {
        expect(onServer.has(id) || deleted.has(id) || refused.has(id)).toBe(true);
      }
    },
  );
});
