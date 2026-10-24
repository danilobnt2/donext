import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { migrate } from '../src/schema';

const FIRST = '01J9ZZZZZZZZZZZZZZZZZZZZZA';
const SECOND = '01J9ZZZZZZZZZZZZZZZZZZZZZB';
const T0 = '2026-10-01T00:00:00.000Z';

it('gives To-Dos from the previous release a first revision, and leaves them where they are', async () => {
  await runInDurableObject(env.USER_STORE.getByName('schema-backfill'), (_instance, state) => {
    const sql = state.storage.sql;
    // Rewind to the previous release's schema, then add rows it could have written.
    sql.exec('DROP TABLE entity_revisions');
    sql.exec('DELETE FROM schema_migrations WHERE version > 1');
    sql.exec(
      `INSERT INTO work_items (id, type, title, state, rev, created_at, updated_at)
       VALUES (?, 'todo', 'First', 'new', 1, ?, ?), (?, 'todo', 'Second', 'new', 1, ?, ?)`,
      FIRST,
      T0,
      T0,
      SECOND,
      T0,
      T0,
    );

    migrate(state.storage);
    migrate(state.storage); // running again must change nothing

    const revisions = sql
      .exec<{ item_id: string; entity: string; rev: number; source: string; snapshot: string }>(
        'SELECT item_id, entity, rev, source, snapshot FROM entity_revisions ORDER BY seq',
      )
      .toArray();
    expect(revisions.map((row) => [row.item_id, row.entity, row.rev, row.source])).toEqual([
      [FIRST, 'todo', 1, 'system'],
      [SECOND, 'todo', 1, 'system'],
    ]);
    const item = { entity: 'todo', rev: 1, createdAt: T0, updatedAt: T0 };
    expect(revisions.map((row) => JSON.parse(row.snapshot))).toEqual([
      { ...item, id: FIRST, fields: { title: 'First', state: 'new' } },
      { ...item, id: SECOND, fields: { title: 'Second', state: 'new' } },
    ]);

    // The data itself stays in its own table: the log is only history and the sync cursor.
    expect(sql.exec('SELECT COUNT(*) AS count FROM work_items').one().count).toBe(2);
  });
});
