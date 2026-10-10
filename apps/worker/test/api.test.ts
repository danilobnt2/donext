import { TITLE_MAX_LENGTH, TODO_LIMIT, type Todo } from '@donext/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const api = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`https://donext.test${path}`, init));

const post = (body: unknown) =>
  api('/api/todos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('GET /api/health', () => {
  it('reports the environment and version', async () => {
    const res = await api('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', environment: 'development', version: 'dev' });
  });
});

describe('/api/todos', () => {
  it('starts empty', async () => {
    const res = await api('/api/todos');
    expect(await res.json()).toEqual({ todos: [] });
  });

  it('creates a To-Do in state New and lists it, newest first', async () => {
    const first = await post({ title: '  Cut the lawn ' });
    expect(first.status).toBe(201);
    const { todo } = await first.json<{ todo: Todo }>();
    expect(todo).toMatchObject({ title: 'Cut the lawn', state: 'new' });
    expect(todo.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    await post({ title: 'Renew passport' });
    const { todos } = await (await api('/api/todos')).json<{ todos: Todo[] }>();
    expect(todos.map((t) => t.title)).toEqual(['Renew passport', 'Cut the lawn']);
  });

  it.each([
    ['a missing title', {}],
    ['a blank title', { title: '   ' }],
    ['a non-string title', { title: 7 }],
    ['an over-long title', { title: 'x'.repeat(TITLE_MAX_LENGTH + 1) }],
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

  it('rejects bodies over 4 KB', async () => {
    const res = await post({ title: 'x', padding: 'y'.repeat(5000) });
    expect(res.status).toBe(413);
  });

  it('refuses new To-Dos once the board holds TODO_LIMIT', async () => {
    const stub = env.USER_STORE.getByName('shared-board');
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO work_items (id, type, title, state, rev, created_at, updated_at)
         SELECT printf('seed%022d', i), 'todo', 'seed', 'new', 1, '', '' FROM n`,
        TODO_LIMIT,
      );
    });
    const res = await post({ title: 'One too many' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'todo_limit_reached' } });
  });

  it('allows only GET and POST', async () => {
    const res = await api('/api/todos', { method: 'DELETE' });
    expect(res.status).toBe(405);
  });
});

describe('unknown API routes', () => {
  it('return a JSON 404', async () => {
    const res = await api('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
