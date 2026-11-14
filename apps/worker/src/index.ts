import { type ApiError, type ApiErrorCode } from '@donext/shared';

export { UserStore } from './user-store';

/** Every request uses this one store until sign-in gives each user their own. */
const SHARED_BOARD = 'shared-board';

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/v1/health') {
      return Response.json({ status: 'ok', environment: env.ENVIRONMENT, version: env.GIT_SHA });
    }

    if (pathname === '/api/v1/sync') {
      if (request.method !== 'GET') {
        return new Response(null, { status: 405, headers: { Allow: 'GET' } });
      }
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade.', { status: 426 });
      }
      return env.USER_STORE.getByName(SHARED_BOARD).fetch(request);
    }

    if (pathname === '/api/v1/board') {
      if (request.method !== 'DELETE') {
        return new Response(null, { status: 405, headers: { Allow: 'DELETE' } });
      }
      return Response.json(await env.USER_STORE.getByName(SHARED_BOARD).resetBoard());
    }

    return apiError(404, 'not_found', 'No such endpoint.');
  },
} satisfies ExportedHandler<Env>;

function apiError(status: number, code: ApiErrorCode, message: string): Response {
  const body: ApiError = { error: { code, message } };
  return Response.json(body, { status });
}
