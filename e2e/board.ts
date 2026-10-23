import { MemoryStore, SyncEngine, httpTransport } from '@donext/shared';
import type { APIRequestContext } from '@playwright/test';
import { monotonicFactory } from 'ulid';

const newId = monotonicFactory();

/**
 * Opens the shared board through the public sync API, the way another device would, so tests
 * can set up and check the server's state without going through the page.
 */
async function openBoard(request: APIRequestContext): Promise<SyncEngine> {
  const transport = httpTransport(async (path, init) => {
    const response = await request.fetch(path, {
      method: init?.method ?? 'GET',
      ...(init?.headers ? { headers: init.headers } : {}),
      ...(init?.body ? { data: init.body } : {}),
    });
    return { ok: response.ok(), status: response.status(), json: () => response.json() };
  });
  const engine = await SyncEngine.open({ store: new MemoryStore(), transport, newId });
  await settle(engine);
  return engine;
}

async function settle(engine: SyncEngine): Promise<void> {
  const outcome = await engine.sync();
  if (!outcome.ok) throw outcome.error;
}

/** Hides every To-Do on the board, so a test starts from an empty one. */
export async function resetBoard(request: APIRequestContext): Promise<void> {
  const board = await openBoard(request);
  await board.abandonAll();
  await settle(board);
}

/** Adds To-Dos in order, so the last one is the newest. */
export async function seedTodos(request: APIRequestContext, titles: string[]): Promise<void> {
  const board = await openBoard(request);
  for (const title of titles) await board.createTodo(title);
  await settle(board);
}

/** The titles the server shows, newest first. */
export async function boardTitles(request: APIRequestContext): Promise<string[]> {
  return (await openBoard(request)).view().map((todo) => todo.title);
}
