import { describe, expect, it } from 'vitest';
import { api } from './helpers';

describe('GET /api/v1/health', () => {
  it('reports the environment and version', async () => {
    const res = await api('/api/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', environment: 'development', version: 'dev' });
  });
});

describe('unknown API routes', () => {
  it.each(['/api/nope', '/api/todos', '/api/v1/todos'])('%s returns a JSON 404', async (path) => {
    const res = await api(path);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
