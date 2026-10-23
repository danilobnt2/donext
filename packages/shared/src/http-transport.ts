import type { Transport } from './client';
import type { ApiError } from './todo';
import type { PullResponse, PushResponse } from './sync';

/** The part of `fetch` the transport needs, so it also runs where DOM types do not exist. */
export type Fetch = (
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Talks to the sync endpoints. Any failure, network or HTTP, becomes a thrown error. */
export function httpTransport(fetchJson: Fetch): Transport {
  return {
    async push(deviceId, ops) {
      const response = await send(fetchJson, '/api/v1/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId, ops }),
      });
      return (response as PushResponse).results;
    },
    async pull(after, limit) {
      const response = await send(fetchJson, `/api/v1/sync?after=${after}&limit=${limit}`);
      return response as PullResponse;
    },
  };
}

async function send(fetchJson: Fetch, path: string, init?: Parameters<Fetch>[1]): Promise<unknown> {
  const response = await fetchJson(path, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (body as ApiError | null)?.error?.message;
    throw new Error(message ?? `Request failed (${response.status}).`);
  }
  return body;
}
