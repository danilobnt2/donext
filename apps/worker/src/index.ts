import { checkTitle, type ApiError, type ApiErrorCode } from '@donext/shared';
import type { UserStore } from './user-store';

export { UserStore } from './user-store';

/** Every request uses this one store until sign-in gives each user their own. */
const SHARED_BOARD = 'shared-board';
const MAX_BODY_BYTES = 4096;

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/health') {
      return Response.json({ status: 'ok', environment: env.ENVIRONMENT, version: env.GIT_SHA });
    }

    if (pathname === '/api/todos') {
      const store = env.USER_STORE.getByName(SHARED_BOARD);
      if (request.method === 'GET') return Response.json({ todos: await store.listTodos() });
      if (request.method === 'POST') return createTodo(request, store);
      return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
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

  const title = checkTitle(
    body !== null && typeof body === 'object' && 'title' in body ? body.title : undefined,
  );
  if (!title.ok) return apiError(400, 'invalid_title', title.message);

  const result = await store.createTodo(title.title);
  if (!result.ok) return apiError(409, 'todo_limit_reached', 'This board is full.');
  return Response.json({ todo: result.todo }, { status: 201 });
}

function tooLarge(): Response {
  return apiError(413, 'payload_too_large', `Body must be at most ${MAX_BODY_BYTES} bytes.`);
}

function apiError(status: number, code: ApiErrorCode, message: string): Response {
  const body: ApiError = { error: { code, message } };
  return Response.json(body, { status });
}
