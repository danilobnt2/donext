import {
  DEFAULT_PULL_LIMIT,
  MAX_PULL_LIMIT,
  checkTitle,
  parsePushRequest,
  type ApiError,
  type ApiErrorCode,
  type PushResponse,
} from '@donext/shared';
import type { UserStore } from './user-store';

export { UserStore } from './user-store';

/** Every request uses this one store until sign-in gives each user their own. */
const SHARED_BOARD = 'shared-board';
const MAX_BODY_BYTES = 4096;
/** A push holds up to MAX_OPS_PER_PUSH changes, each with a title of up to 500 characters. */
const MAX_SYNC_BODY_BYTES = 256 * 1024;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/v1/health') {
      return Response.json({ status: 'ok', environment: env.ENVIRONMENT, version: env.GIT_SHA });
    }

    if (pathname === '/api/v1/sync') {
      const store = env.USER_STORE.getByName(SHARED_BOARD);
      if (request.method === 'GET') return pullChanges(url, store);
      if (request.method === 'POST') return pushOps(request, store);
      return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
    }

    if (pathname === '/api/v1/todos') {
      const store = env.USER_STORE.getByName(SHARED_BOARD);
      if (request.method === 'GET') return Response.json({ todos: await store.listTodos() });
      if (request.method === 'POST') return createTodo(request, store);
      if (request.method === 'DELETE')
        return Response.json({ deleted: await store.deleteAllTodos() });
      return new Response(null, { status: 405, headers: { Allow: 'GET, POST, DELETE' } });
    }

    return apiError(404, 'not_found', 'No such endpoint.');
  },
} satisfies ExportedHandler<Env>;

async function createTodo(
  request: Request,
  store: DurableObjectStub<UserStore>,
): Promise<Response> {
  const read = await readJson(request, MAX_BODY_BYTES);
  if (!read.ok) return read.response;
  const { body } = read;

  const title = checkTitle(
    body !== null && typeof body === 'object' && 'title' in body ? body.title : undefined,
  );
  if (!title.ok) return apiError(400, 'invalid_title', title.message);

  const result = await store.createTodo(title.title);
  if (!result.ok) return apiError(409, 'todo_limit_reached', 'This board is full.');
  return Response.json({ todo: result.todo }, { status: 201 });
}

async function pushOps(request: Request, store: DurableObjectStub<UserStore>): Promise<Response> {
  const read = await readJson(request, MAX_SYNC_BODY_BYTES);
  if (!read.ok) return read.response;
  const push = parsePushRequest(read.body);
  if (!push.ok) return apiError(400, 'invalid_request', push.message);
  const response: PushResponse = { results: await store.applyOps(push.ops) };
  return Response.json(response);
}

async function pullChanges(url: URL, store: DurableObjectStub<UserStore>): Promise<Response> {
  const after = integerParam(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integerParam(url, 'limit', DEFAULT_PULL_LIMIT, 1, MAX_PULL_LIMIT);
  if (after === null || limit === null) {
    return apiError(
      400,
      'invalid_request',
      `after must be a non-negative integer and limit between 1 and ${MAX_PULL_LIMIT}.`,
    );
  }
  return Response.json(await store.pull(after, limit));
}

/** Reads a query parameter as an integer in [min, max]; null when present but invalid. */
function integerParam(url: URL, name: string, fallback: number, min: number, max: number) {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return raw.trim() !== '' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

type JsonBody = { ok: true; body: unknown } | { ok: false; response: Response };

async function readJson(request: Request, maxBytes: number): Promise<JsonBody> {
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > maxBytes) return { ok: false, response: tooLarge(maxBytes) };
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return { ok: false, response: tooLarge(maxBytes) };
  }
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: apiError(400, 'invalid_json', 'Body must be JSON.') };
  }
}

function tooLarge(maxBytes: number): Response {
  return apiError(413, 'payload_too_large', `Body must be at most ${maxBytes} bytes.`);
}

function apiError(status: number, code: ApiErrorCode, message: string): Response {
  const body: ApiError = { error: { code, message } };
  return Response.json(body, { status });
}
