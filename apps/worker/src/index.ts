import { Todos, type ApiError, type ApiErrorCode, type Meta, type Todo } from '@donext/shared';
import { ulid } from 'ulid';
import type { UserStore } from './user-store';

export { UserStore } from './user-store';

/** Every request uses this one store until sign-in gives each user their own. */
const SHARED_BOARD = 'shared-board';
const MAX_BODY_BYTES = 4096;

/** Every change so far comes from the app, which sends no device details yet. */
const FROM_APP: Meta = { actor: { kind: 'device' }, deviceChangedAt: null };

/** HTTP status for each rule a change can break; any other code is a 400. */
const STATUS: Partial<Record<ApiErrorCode, number>> = {
  already_exists: 409,
  todo_limit_reached: 409,
};

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/v1/health') {
      return Response.json({ status: 'ok', environment: env.ENVIRONMENT, version: env.GIT_SHA });
    }

    if (pathname === '/api/v1/todos') {
      const store = env.USER_STORE.getByName(SHARED_BOARD);
      if (request.method === 'GET') {
        const board = await store.newestPer('todoVersion', 'todoId', 'version');
        return Response.json({ todos: board.map(toTodo) });
      }
      if (request.method === 'POST') return createTodo(request, store);
      if (request.method === 'DELETE') {
        // Reports To-Dos, not versions; the brief gap between the two calls is harmless here.
        const deleted = await store.count('todoVersion', 'todoId');
        await store.deleteAll('todoVersion');
        return Response.json({ deleted });
      }
      return new Response(null, { status: 405, headers: { Allow: 'GET, POST, DELETE' } });
    }

    return apiError(404, 'not_found', 'No such endpoint.');
  },
} satisfies ExportedHandler<Env>;

async function createTodo(
  request: Request,
  store: DurableObjectStub<UserStore>,
): Promise<Response> {
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_BODY_BYTES) return tooLarge();
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return tooLarge();

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return apiError(400, 'invalid_json', 'Body must be JSON.');
  }

  // Devices will send their own ids once they create To-Dos offline.
  const change = Todos.parseCreate(body, ulid());
  if (!change.ok) return ruleError(change);

  const result = await store.write('todoVersion', change.value, FROM_APP);
  if (!result.ok) return ruleError(result);
  const [created] = result.value;
  if (!created) throw new Error(`Creating To-Do ${change.value.todoId} wrote nothing.`);
  return Response.json({ todo: toTodo(created) }, { status: 201 });
}

/** A To-Do as the API returns it: its newest version. */
function toTodo(todo: Todos.Entity): Todo {
  return {
    id: todo.todoId,
    title: todo.title,
    state: todo.state,
    createdAt: new Date(todo.createdAt).toISOString(),
  };
}

function ruleError(broken: { code: ApiErrorCode; message: string }): Response {
  return apiError(STATUS[broken.code] ?? 400, broken.code, broken.message);
}

function tooLarge(): Response {
  return apiError(413, 'payload_too_large', `Body must be at most ${MAX_BODY_BYTES} bytes.`);
}

function apiError(status: number, code: ApiErrorCode, message: string): Response {
  const body: ApiError = { error: { code, message } };
  return Response.json(body, { status });
}
