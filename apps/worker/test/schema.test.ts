import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { migrate } from '../src/schema';

const FIRST = '01J9ZZZZZZZZZZZZZZZZZZZZZA';
const SECOND = '01J9ZZZZZZZZZZZZZZZZZZZZZB';
const T0 = '2026-10-01T00:00:00.000Z';

it('gives every To-Do that predates the revision log a first revision', async () => {
  await runInDurableObject(env.USER_STORE.getByName('schema-backfill'), (_instance, state) => {
    const sql = state.storage.sql;
    // Rewind to the previous release's schema, then add rows it could have written.
    sql.exec('DROP TABLE work_item_revisions');
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

    const rows = sql
      .exec<{ item_id: string; rev: number; source: string; snapshot: string }>(
        'SELECT item_id, rev, source, snapshot FROM work_item_revisions ORDER BY seq',
      )
      .toArray();
    expect(rows.map((row) => [row.item_id, row.rev, row.source])).toEqual([
      [FIRST, 1, 'system'],
      [SECOND, 1, 'system'],
    ]);
    expect(rows.map((row) => JSON.parse(row.snapshot))).toEqual([
      { id: FIRST, title: 'First', state: 'new', rev: 1, createdAt: T0, updatedAt: T0 },
      { id: SECOND, title: 'Second', state: 'new', rev: 1, createdAt: T0, updatedAt: T0 },
    ]);
  });
});
