import {
  Todos,
  parseDeviceMeta,
  type ApiError,
  type ApiErrorCode,
  type Todo,
  type TodoVersion,
  type Entity,
  type Writes,
} from '@donext/shared';
import { ulid } from 'ulid';
import type { UserStore } from './user-store';

export { UserStore } from './user-store';

/** Every request uses this one store until sign-in gives each user their own. */
const SHARED_BOARD = 'shared-board';
/** Fits the longest title and notes even if every character is JSON-escaped. */
const MAX_BODY_BYTES = 32 * 1024;
const VERSIONS_PAGE_SIZE = 100;

const TODO_PATH = /^\/api\/v1\/todos\/([0-9A-HJKMNP-TV-Z]{26})$/;
const VERSIONS_PATH = /^\/api\/v1\/todos\/([0-9A-HJKMNP-TV-Z]{26})\/versions$/;

/** HTTP status for each rule a change can break; any other code is a 400. */
const STATUS: Partial<Record<ApiErrorCode, number>> = {
  not_found: 404,
  already_exists: 409,
  todo_limit_reached: 409,
};

type UserStub = DurableObjectStub<UserStore>;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/v1/health') {
      return Response.json({ status: 'ok', environment: env.ENVIRONMENT, version: env.GIT_SHA });
    }

    const store = env.USER_STORE.getByName(SHARED_BOARD);

    if (pathname === '/api/v1/todos') {
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

async function createTodo(request: Request, store: UserStub): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  // Devices will send their own ids once they create To-Dos offline.
  const change = Todos.parseCreate(body, ulid());
  if (!change.ok) return ruleError(change);
  const meta = parseDeviceMeta(body);
  if (!meta.ok) return ruleError(meta);

  const result = await store.write('todoVersion', change.value, meta.value);
  if (!result.ok) return ruleError(result);
  return Response.json(
    { todo: toTodo(await written(store, change.value.todoId, result.value)) },
    { status: 201 },
  );
}

async function editTodo(request: Request, store: UserStub, id: string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const change = Todos.parseEdit(body, id);
  if (!change.ok) return ruleError(change);
  const meta = parseDeviceMeta(body);
  if (!meta.ok) return ruleError(meta);

  const result = await store.write('todoVersion', change.value, meta.value);
  if (!result.ok) return ruleError(result);
  return Response.json({ todo: toTodo(await written(store, id, result.value)) });
}

async function listVersions(url: URL, store: UserStub, id: string): Promise<Response> {
  const beforeParam = url.searchParams.get('before');
  const before = beforeParam === null ? null : Number(beforeParam);
  if (before !== null && !(Number.isSafeInteger(before) && before >= 1)) {
    return apiError(400, 'invalid_cursor', 'before must be a version number.');
  }
  const versions = await store.find('todoVersion', {
    where: { todoId: id },
    ...(before === null ? {} : { before: { field: 'version' as const, value: before } }),
    orderBy: { field: 'version', desc: true },
    limit: VERSIONS_PAGE_SIZE,
  });
  if (versions.length === 0 && before === null) return apiError(404, 'not_found', 'No such To-Do.');
  const last = versions.at(-1);
  const nextBefore = versions.length === VERSIONS_PAGE_SIZE && last ? last.version : null;
  return Response.json({ versions: versions.map(toTodoVersion), nextBefore });
}

/** The To-Do's version a write appended or, if it changed nothing, its newest one. */
async function written(
  store: UserStub,
  todoId: string,
  writes: Writes<Entity>,
): Promise<Todos.Entity> {
  const appended = writes.put.find((e) => e.kind === 'todoVersion' && e.todoId === todoId);
  if (appended) return appended;
  const [newest] = await store.find('todoVersion', {
    where: { todoId },
    orderBy: { field: 'version', desc: true },
    limit: 1,
  });
  if (!newest) throw new Error(`To-Do ${todoId} has no version after a write.`);
  return newest;
}

/** A To-Do as the API returns it: its newest version. */
function toTodo(todo: Todos.Entity): Todo {
  return {
    id: todo.todoId,
    title: todo.title,
    notes: todo.notes,
    dueDate: todo.dueDate,
    state: todo.state,
    version: todo.version,
    createdAt: new Date(todo.createdAt).toISOString(),
    updatedAt: new Date(todo.changedAt).toISOString(),
  };
}

/** One version of a To-Do as the API returns it. */
function toTodoVersion(todo: Todos.Entity): TodoVersion {
  return {
    version: todo.version,
    change: todo.change,
    changedFields: todo.changedFields,
    changedAt: new Date(todo.changedAt).toISOString(),
    deviceChangedAt:
      todo.deviceChangedAt === null ? null : new Date(todo.deviceChangedAt).toISOString(),
    actor: todo.actor,
    todo: { title: todo.title, notes: todo.notes, dueDate: todo.dueDate, state: todo.state },
  };
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

function ruleError(broken: { code: ApiErrorCode; message: string }): Response {
  return apiError(STATUS[broken.code] ?? 400, broken.code, broken.message);
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
