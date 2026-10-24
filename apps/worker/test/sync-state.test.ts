import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SYNC_LIMITS, SyncState } from '../src/sync-state';

const defaults = { ...SYNC_LIMITS };
afterEach(() => Object.assign(SYNC_LIMITS, defaults));

const withState = <T>(run: (sync: SyncState, sql: SqlStorage) => T) =>
  runInDurableObject(env.USER_STORE.getByName('sync-state'), (_instance, state) =>
    run(new SyncState(state.storage.sql), state.storage.sql),
  );

beforeEach(() =>
  withState((_sync, sql) => {
    sql.exec('DELETE FROM sync_deletions');
    sql.exec('DELETE FROM sync_applied_ops');
    sql.exec("UPDATE sync_state SET value = 0 WHERE key IN ('seq', 'watermark')");
  }),
);

describe('SyncState', () => {
  it('hands out increasing sequence numbers', async () => {
    await withState((sync) => {
      expect([sync.nextSeq(), sync.nextSeq(), sync.nextSeq()]).toEqual([1, 2, 3]);
      expect(sync.latestSeq()).toBe(3);
    });
  });

  it('remembers recent operations, and only the most recent', async () => {
    SYNC_LIMITS.maxAppliedOps = 3;
    await withState((sync) => {
      for (const id of ['a', 'b', 'c', 'd', 'e']) sync.markApplied(id);
      expect(['a', 'b', 'c', 'd', 'e'].map((id) => sync.wasApplied(id))).toEqual([
        false,
        false,
        true,
        true,
        true,
      ]);
    });
  });

  it('remembers deletions up to its cap, and marks how far it has forgotten', async () => {
    SYNC_LIMITS.maxDeletions = 2;
    await withState((sync) => {
      sync.recordDeletion('todo', 'x', 10);
      sync.recordDeletion('todo', 'y', 20);
      expect(sync.watermark()).toBe(0);

      sync.recordDeletion('todo', 'z', 30);
      sync.recordDeletion('todo', 'w', 40);
      expect(sync.deletionsSince(0, 10).map((change) => change.id)).toEqual(['z', 'w']);
      expect(sync.watermark()).toBe(20);
      expect(sync.deletionsSince(30, 10)).toEqual([
        { seq: 40, entity: 'todo', id: 'w', item: null },
      ]);
    });
  });
});
