import { Todos, parseDeviceMeta, type ApiError, type ApiErrorCode } from '@donext/shared';
import type { UserStore } from './user-store';

export { UserStore } from './user-store';

/** Every request uses this one store until sign-in gives each user their own. */
const SHARED_BOARD = 'shared-board';
/** Fits the longest title and notes even if every character is JSON-escaped. */
const MAX_BODY_BYTES = 32 * 1024;
const VERSIONS_PAGE_SIZE = 100;

const TODO_PATH = /^\/api\/v1\/todos\/([0-9A-HJKMNP-TV-Z]{26})$/;
const VERSIONS_PATH = /^\/api\/v1\/todos\/([0-9A-HJKMNP-TV-Z]{26})\/versions$/;

type Store = DurableObjectStub<UserStore>;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/v1/health') {
      return Response.json({ status: 'ok', environment: env.ENVIRONMENT, version: env.GIT_SHA });
    }

    const store = env.USER_STORE.getByName(SHARED_BOARD);

    if (pathname === '/api/v1/todos') {
      if (request.method === 'GET') return Response.json({ todos: await store.listTodos() });
      if (request.method === 'POST') return createTodo(request, store);
      if (request.method === 'DELETE')
        return Response.json({ deleted: await store.deleteAllTodos() });
      return methodNotAllowed('GET, POST, DELETE');
    }

    const todoId = TODO_PATH.exec(pathname)?.[1];
    if (todoId) {
      if (request.method === 'PATCH') return editTodo(request, store, todoId);
      return methodNotAllowed('PATCH');
    }

    const versionsOf = VERSIONS_PATH.exec(pathname)?.[1];
    if (versionsOf) {
      if (request.method === 'GET') return listVersions(url, store, versionsOf);
      return methodNotAllowed('GET');
    }

    return apiError(404, 'not_found', 'No such endpoint.');
  },
} satisfies ExportedHandler<Env>;

async function createTodo(request: Request, store: Store): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const change = Todos.parseCreate(body);
  if (!change.ok) return apiError(400, change.code, change.message);
  const meta = parseDeviceMeta(body);
  if (!meta.ok) return apiError(400, meta.code, meta.message);

  const result = await store.createTodo(change.value, meta.value);
  if (!result.ok) return apiError(409, 'todo_limit_reached', 'This board is full.');
  return Response.json({ todo: result.todo }, { status: 201 });
}

async function editTodo(request: Request, store: Store, id: string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const change = Todos.parseEdit(body);
  if (!change.ok) return apiError(400, change.code, change.message);
  const meta = parseDeviceMeta(body);
  if (!meta.ok) return apiError(400, meta.code, meta.message);

  const result = await store.editTodo(id, change.value, meta.value);
  if (!result.ok) return apiError(404, 'not_found', 'No such To-Do.');
  return Response.json({ todo: result.todo });
}

async function listVersions(url: URL, store: Store, id: string): Promise<Response> {
  const beforeParam = url.searchParams.get('before');
  const before = beforeParam === null ? null : Number(beforeParam);
  if (before !== null && !(Number.isSafeInteger(before) && before >= 1)) {
    return apiError(400, 'invalid_cursor', 'before must be a version number.');
  }
  const versions = await store.listTodoVersions(id, before, VERSIONS_PAGE_SIZE);
  if (!versions) return apiError(404, 'not_found', 'No such To-Do.');
  const last = versions.at(-1);
  const nextBefore = versions.length === VERSIONS_PAGE_SIZE && last ? last.version : null;
  return Response.json({ versions, nextBefore });
}

/** Reads a JSON body of at most MAX_BODY_BYTES, or returns the error response. */
async function readJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_BODY_BYTES) return tooLarge();
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return tooLarge();
  try {
    return JSON.parse(text);
  } catch {
    return apiError(400, 'invalid_json', 'Body must be JSON.');
  }
}

function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { Allow: allow } });
}

function tooLarge(): Response {
  return apiError(413, 'payload_too_large', `Body must be at most ${MAX_BODY_BYTES} bytes.`);
}

function apiError(status: number, code: ApiErrorCode, message: string): Response {
  const body: ApiError = { error: { code, message } };
  return Response.json(body, { status });
}
