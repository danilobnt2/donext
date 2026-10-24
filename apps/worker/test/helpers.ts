import type { Fields, OpResult, PullResponse, PushResponse, SyncOp } from '@donext/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { expect } from 'vitest';
import { ulid } from 'ulid';

export const api = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`https://donext.test${path}`, init));

export const board = () => env.USER_STORE.getByName('shared-board');

/** Empties the shared board, domain data and sync bookkeeping alike. */
export const resetBoard = () =>
  runInDurableObject(board(), (_instance, state) => {
    const { sql } = state.storage;
    sql.exec('DELETE FROM work_items');
    sql.exec('DELETE FROM sync_deletions');
    sql.exec('DELETE FROM sync_applied_ops');
    sql.exec("UPDATE sync_state SET value = 0 WHERE key IN ('seq', 'watermark')");
  });

let counter = 0;
export const opId = () => `op-${++counter}`;

export const create = (title: string, itemId = ulid(), fields: Fields = { title }): SyncOp => ({
  kind: 'create',
  opId: opId(),
  entity: 'todo',
  itemId,
  fields,
});

export const update = (itemId: string, changes: Fields, baseRev = 1): SyncOp => ({
  kind: 'update',
  opId: opId(),
  entity: 'todo',
  itemId,
  baseRev,
  changes,
});

export const remove = (itemId: string): SyncOp => ({
  kind: 'delete',
  opId: opId(),
  entity: 'todo',
  itemId,
});

export const postRaw = (body: unknown) =>
  api('/api/v1/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

export const push = async (ops: unknown[], deviceId = 'dev-a'): Promise<OpResult[]> => {
  const res = await postRaw({ deviceId, ops });
  expect(res.status).toBe(200);
  return (await res.json<PushResponse>()).results;
};

export const pushOne = async (op: SyncOp): Promise<OpResult> => (await push([op]))[0]!;

export const pull = async (query = ''): Promise<PullResponse> => {
  const res = await api(`/api/v1/sync${query}`);
  expect(res.status).toBe(200);
  return res.json<PullResponse>();
};

/** Pulls and expects a normal answer, not a request to resync. */
export const changes = async (query = '') => {
  const response = await pull(query);
  if (response.resync) throw new Error('unexpected resync');
  return response;
};
