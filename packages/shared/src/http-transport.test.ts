import { describe, expect, it } from 'vitest';
import { httpTransport, type Fetch } from './http-transport';

const reply = (status: number, body: unknown): ReturnType<Fetch> =>
  Promise.resolve({ ok: status < 300, status, json: async () => body });

describe('httpTransport', () => {
  it('posts the device id and operations and returns the results', async () => {
    const calls: Parameters<Fetch>[] = [];
    const transport = httpTransport(async (...args) => {
      calls.push(args);
      return reply(200, { results: [{ opId: 'op1', status: 'applied' }] });
    });
    expect(await transport.push('dev-1', [])).toEqual([{ opId: 'op1', status: 'applied' }]);
    expect(calls[0]?.[0]).toBe('/api/v1/sync');
    expect(calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(calls[0]?.[1]?.body ?? '')).toEqual({ deviceId: 'dev-1', ops: [] });
  });

  it('asks for changes after the cursor', async () => {
    const paths: string[] = [];
    const transport = httpTransport(async (path) => {
      paths.push(path);
      return reply(200, { resync: true });
    });
    expect(await transport.pull(7, 500)).toEqual({ resync: true });
    expect(paths).toEqual(['/api/v1/sync?after=7&limit=500']);
  });

  it('throws the server’s message on an error response', async () => {
    const transport = httpTransport(async () =>
      reply(400, { error: { code: 'invalid_request', message: 'ops must be a list.' } }),
    );
    await expect(transport.push('dev-1', [])).rejects.toThrow('ops must be a list.');
  });

  it('throws a generic error when the response is not JSON', async () => {
    const transport = httpTransport(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('not json');
      },
    }));
    await expect(transport.pull(0, 10)).rejects.toThrow('Request failed (502).');
  });
});
