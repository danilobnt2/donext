import { Todos, VERSION_LIMIT, type Todo, type TodoVersion } from '@donext/shared';
import { runInDurableObject } from 'cloudflare:test';
import { migrate } from '../src/schema';
import { CURRENT_TODOS } from '../src/sql-store';
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

const api = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`https://donext.test${path}`, init));

// Durable Object storage persists across tests in this file, so start each one empty.
beforeEach(async () => {
  await runInDurableObject(env.USER_STORE.getByName('shared-board'), (_instance, state) => {
    state.storage.sql.exec('DELETE FROM todo_versions');
  });
});

const send = (method: string, path: string, body: unknown) =>
  api(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const post = (body: unknown) => send('POST', '/api/v1/todos', body);
const patch = (id: string, body: unknown) => send('PATCH', `/api/v1/todos/${id}`, body);
const versionsOf = async (id: string, query = '') =>
  (await api(`/api/v1/todos/${id}/versions${query}`)).json<{
    versions: TodoVersion[];
    nextBefore: number | null;
  }>();
const created = async (body: unknown) => (await (await post(body)).json<{ todo: Todo }>()).todo;

/** Inserts `count` versions numbered from `from` for one To-Do, straight into storage. */
const seedVersions = (id: string, from: number, count: number) =>
  runInDurableObject(env.USER_STORE.getByName('shared-board'), (_instance, state) => {
    state.storage.sql.exec(
      `WITH RECURSIVE n(i) AS (SELECT CAST(?1 AS INTEGER) UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
       INSERT INTO todo_versions (todo_id, version, title, notes, due_date, state, created_at,
         change, changed_fields, changed_at, device_changed_at, actor_kind, actor_id)
       SELECT ?3, i, 'v' || i, '', NULL, 'new',
         (SELECT MIN(created_at) FROM todo_versions WHERE todo_id = ?3),
         'edit', '["title"]', i, NULL, 'device', NULL
       FROM n`,
      from,
      from + count - 1,
      id,
    );
  });

describe('GET /api/v1/health', () => {
  it('reports the environment and version', async () => {
    const res = await api('/api/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', environment: 'development', version: 'dev' });
  });
});

describe('/api/v1/todos', () => {
  it('starts empty', async () => {
    const res = await api('/api/v1/todos');
    expect(await res.json()).toEqual({ todos: [] });
  });

  it('creates a To-Do in state New and lists it, newest first', async () => {
    const first = await post({ title: '  Cut the lawn ' });
    expect(first.status).toBe(201);
    const { todo } = await first.json<{ todo: Todo }>();
    expect(todo).toMatchObject({
      title: 'Cut the lawn',
      notes: '',
      dueDate: null,
      state: 'new',
      version: 1,
    });
    expect(todo.updatedAt).toBe(todo.createdAt);
    expect(todo.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    await post({ title: 'Renew passport' });
    const { todos } = await (await api('/api/v1/todos')).json<{ todos: Todo[] }>();
    expect(todos.map((t) => t.title)).toEqual(['Renew passport', 'Cut the lawn']);
  });

  it.each([
    ['a missing title', {}],
    ['a blank title', { title: '   ' }],
    ['a non-string title', { title: 7 }],
    ['an over-long title', { title: 'x'.repeat(Todos.TITLE_MAX_LENGTH + 1) }],
  ])('rejects %s', async (_, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_title' } });
  });

  it('rejects malformed JSON', async () => {
    const res = await post('{nope');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_json' } });
  });

  it('rejects bodies over 32 KB', async () => {
    const res = await post({ title: 'x', padding: 'y'.repeat(33 * 1024) });
    expect(res.status).toBe(413);
  });

  it('refuses new To-Dos once the board holds Todos.LIMIT', async () => {
    const stub = env.USER_STORE.getByName('shared-board');
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO todo_versions (todo_id, version, title, notes, due_date, state, created_at,
           change, changed_fields, changed_at, device_changed_at, actor_kind, actor_id)
         SELECT printf('SEED%022d', i), 1, 'seed', '', NULL, 'new', 0, 'create', '[]', 0, NULL,
           'device', NULL
         FROM n`,
        Todos.LIMIT,
      );
    });
    const res = await post({ title: 'One too many' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'todo_limit_reached' } });
  });

  it('lets exactly one of several concurrent creates take the last slot', async () => {
    await runInDurableObject(env.USER_STORE.getByName('shared-board'), (_instance, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO todo_versions (todo_id, version, title, notes, due_date, state, created_at,
           change, changed_fields, changed_at, device_changed_at, actor_kind, actor_id)
         SELECT printf('SEED%022d', i), 1, 'seed', '', NULL, 'new', 0, 'create', '[]', 0, NULL,
           'device', NULL
         FROM n`,
        Todos.LIMIT - 1,
      );
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => post({ title: `Racer ${i}` })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
  });

  it('deletes every To-Do', async () => {
    await post({ title: 'Cut the lawn' });
    await post({ title: 'Renew passport' });
    const res = await api('/api/v1/todos', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2 });
    expect(await (await api('/api/v1/todos')).json()).toEqual({ todos: [] });
  });

  it('allows only GET, POST and DELETE', async () => {
    const res = await api('/api/v1/todos', { method: 'PUT' });
    expect(res.status).toBe(405);
  });
});

describe('PATCH /api/v1/todos/:id', () => {
  it('appends a version with the changed fields, keeping the earlier ones', async () => {
    const todo = await created({ title: 'Cut the lawn' });
    const res = await patch(todo.id, {
      notes: 'Front only',
      dueDate: '2026-11-30',
      deviceId: '01JC0000000000000000000000',
      deviceChangedAt: '2026-11-04T09:00:00Z',
    });
    expect(res.status).toBe(200);
    const { todo: edited } = await res.json<{ todo: Todo }>();
    expect(edited).toMatchObject({
      id: todo.id,
      title: 'Cut the lawn',
      notes: 'Front only',
      dueDate: '2026-11-30',
      version: 2,
      createdAt: todo.createdAt,
    });

    const { todos } = await (await api('/api/v1/todos')).json<{ todos: Todo[] }>();
    expect(todos).toEqual([edited]);

    const { versions } = await versionsOf(todo.id);
    expect(versions.map((v) => [v.version, v.change, v.changedFields])).toEqual([
      [2, 'edit', ['notes', 'dueDate']],
      [1, 'create', ['title', 'notes', 'dueDate', 'state']],
    ]);
    expect(versions[0]).toMatchObject({
      deviceChangedAt: '2026-11-04T09:00:00.000Z',
      actor: { kind: 'device', id: '01JC0000000000000000000000' },
      todo: { title: 'Cut the lawn', notes: 'Front only', dueDate: '2026-11-30', state: 'new' },
    });
    expect(versions[1]).toMatchObject({
      deviceChangedAt: null,
      actor: { kind: 'device', id: null },
      todo: { notes: '', dueDate: null },
    });
  });

  it('writes no version when nothing changes', async () => {
    const todo = await created({ title: 'Cut the lawn' });
    const res = await patch(todo.id, { title: ' Cut the lawn ', notes: '' });
    expect(res.status).toBe(200);
    expect((await res.json<{ todo: Todo }>()).todo).toEqual(todo);
    expect((await versionsOf(todo.id)).versions).toHaveLength(1);
  });

  it.each([
    [{}, 'invalid_change'],
    [{ title: '' }, 'invalid_title'],
    [{ dueDate: 'tomorrow' }, 'invalid_due_date'],
    [{ title: 'x', deviceId: 'phone' }, 'invalid_device'],
  ])('rejects %j', async (body, code) => {
    const todo = await created({ title: 'Cut the lawn' });
    const res = await patch(todo.id, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code } });
    expect((await versionsOf(todo.id)).versions).toHaveLength(1);
  });

  it('returns 404 for an unknown To-Do', async () => {
    const res = await patch('01JC0000000000000000000000', { title: 'x' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('keeps the newest VERSION_LIMIT versions, dropping the oldest', async () => {
    const todo = await created({ title: 'Cut the lawn' });
    await seedVersions(todo.id, 2, VERSION_LIMIT - 1);
    const res = await patch(todo.id, { title: 'Still cutting the lawn' });
    expect((await res.json<{ todo: Todo }>()).todo).toMatchObject({
      version: VERSION_LIMIT + 1,
      createdAt: todo.createdAt,
    });

    await runInDurableObject(env.USER_STORE.getByName('shared-board'), (_instance, state) => {
      const range = state.storage.sql
        .exec<{ count: number; oldest: number; newest: number }>(
          'SELECT COUNT(*) AS count, MIN(version) AS oldest, MAX(version) AS newest FROM todo_versions',
        )
        .one();
      expect(range).toEqual({
        count: VERSION_LIMIT,
        oldest: 2,
        newest: VERSION_LIMIT + 1,
      });
    });
  });
});

describe('GET /api/v1/todos/:id/versions', () => {
  it('pages newest first, 100 at a time', async () => {
    const todo = await created({ title: 'Cut the lawn' });
    await seedVersions(todo.id, 2, 149);
    const first = await versionsOf(todo.id);
    expect(first.versions).toHaveLength(100);
    expect(first.versions[0]?.version).toBe(150);
    expect(first.nextBefore).toBe(51);
    const second = await versionsOf(todo.id, '?before=51');
    expect(second.versions.map((v) => v.version)).toEqual(
      Array.from({ length: 50 }, (_, i) => 50 - i),
    );
    expect(second.nextBefore).toBeNull();
  });

  it('rejects a bad cursor and an unknown To-Do', async () => {
    const todo = await created({ title: 'Cut the lawn' });
    expect((await api(`/api/v1/todos/${todo.id}/versions?before=x`)).status).toBe(400);
    expect((await api('/api/v1/todos/01JC0000000000000000000000/versions')).status).toBe(404);
  });
});

describe('board reads', () => {
  it('grow with the number of To-Dos, not with their versions', async () => {
    const ids: string[] = [];
    for (const title of ['A', 'B', 'C']) ids.push((await created({ title })).id);
    for (const id of ids) await seedVersions(id, 2, VERSION_LIMIT - 1);

    await runInDurableObject(env.USER_STORE.getByName('shared-board'), (instance, state) => {
      expect(instance.listTodos().map((t) => [t.title, t.version])).toEqual([
        ['v1000', 1000],
        ['v1000', 1000],
        ['v1000', 1000],
      ]);
      const cursor = state.storage.sql.exec(CURRENT_TODOS);
      cursor.toArray();
      expect(cursor.rowsRead).toBeLessThan(10 * ids.length); // 3,000 versions in total
    });
  });
});

describe('unknown API routes', () => {
  it.each(['/api/nope', '/api/todos'])('%s returns a JSON 404', async (path) => {
    const res = await api(path);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('schema reset', () => {
  it('discards the bootstrap schema and its data, then creates the current one', async () => {
    const stub = env.USER_STORE.getByName('reset-test');
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      // Rewind this object to the bootstrap release's schema and data.
      sql.exec('DROP TABLE todo_versions');
      sql.exec('DELETE FROM schema_migrations');
      sql.exec(
        `CREATE TABLE work_items (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
           state TEXT NOT NULL, rev INTEGER NOT NULL, created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL)`,
      );
      sql.exec(
        "INSERT INTO work_items VALUES ('01JBZZZZZZZZZZZZZZZZZZZZZ1', 'todo', 'Old', 'new', 1, '', '')",
      );
      sql.exec("INSERT INTO schema_migrations VALUES (1, '2026-10-10T00:00:00.000Z')");

      migrate(state.storage);
      migrate(state.storage);

      const tables = sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
        )
        .toArray()
        .map((t) => t.name);
      expect(tables).toEqual(['schema_migrations', 'todo_versions']);
      expect(sql.exec('SELECT COUNT(*) AS n FROM todo_versions').one()).toEqual({ n: 0 });
      expect(sql.exec('SELECT version FROM schema_migrations').toArray()).toEqual([{ version: 1 }]);
    });
  });
});
