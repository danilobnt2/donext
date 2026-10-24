import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { migrate } from '../src/schema';

const FIRST = '01J9ZZZZZZZZZZZZZZZZZZZZZA';
const SECOND = '01J9ZZZZZZZZZZZZZZZZZZZZZB';
const T0 = '2026-10-01T00:00:00.000Z';

it('numbers the previous release’s To-Dos for sync, in the order they were made', async () => {
  await runInDurableObject(env.USER_STORE.getByName('schema-upgrade'), (_instance, state) => {
    const sql = state.storage.sql;
    // Rewind to the previous release's schema, then add rows it could have written.
    sql.exec('DROP TABLE sync_applied_ops');
    sql.exec('DROP TABLE sync_deletions');
    sql.exec('DROP TABLE sync_state');
    sql.exec('DROP INDEX work_items_by_seq');
    sql.exec('ALTER TABLE work_items DROP COLUMN seq');
    sql.exec('DELETE FROM schema_migrations WHERE version > 1');
    sql.exec(
      `INSERT INTO work_items (id, type, title, state, rev, created_at, updated_at)
       VALUES (?, 'todo', 'Second made', 'new', 1, ?, ?), (?, 'todo', 'First made', 'new', 1, ?, ?)`,
      SECOND,
      T0,
      T0,
      FIRST,
      T0,
      T0,
    );

    migrate(state.storage);
    migrate(state.storage); // running again must change nothing

    expect(sql.exec('SELECT id, seq FROM work_items ORDER BY seq').toArray()).toEqual([
      { id: FIRST, seq: 1 },
      { id: SECOND, seq: 2 },
    ]);
    const settings = Object.fromEntries(
      sql
        .exec<{ key: string; value: number }>('SELECT key, value FROM sync_state')
        .toArray()
        .map((r) => [r.key, r.value]),
    );
    expect(settings).toMatchObject({ seq: 2, watermark: 0 });
    expect(settings.epoch).toBeGreaterThan(0);
  });
});
