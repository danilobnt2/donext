import { createGuestSession, findSessionUser } from './session'

export { UserStore } from './user-store'

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  })
}

function store(env: Env, userId: string) {
  return env.USER_STORE.get(env.USER_STORE.idFromName(userId))
}

async function listTodos(request: Request, env: Env): Promise<Response> {
  const userId = await findSessionUser(request, env.DB)
  if (!userId) return json({ todos: [] })
  return json({ todos: await store(env, userId).listTodos() })
}

async function createTodo(request: Request, env: Env): Promise<Response> {
  // Requiring JSON forces a CORS preflight for cross-site callers, on top of SameSite=Lax.
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) {
    return json({ error: { code: 'unsupported_media_type' } }, 415)
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: { code: 'invalid_json' } }, 400)
  }

  let userId = await findSessionUser(request, env.DB)
  const headers: Record<string, string> = {}
  if (!userId) {
    const session = await createGuestSession(env.DB)
    userId = session.userId
    headers['Set-Cookie'] = session.cookie
  }

  const result = await store(env, userId).createTodo(body, 'app')
  if (!result.ok) return json({ error: result.error }, 400, headers)
  return json({ todo: result.todo }, result.created ? 201 : 200, headers)
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url)
    if (!pathname.startsWith('/api/')) return env.ASSETS.fetch(request)

    if (pathname === '/api/health' && request.method === 'GET') {
      return json({ ok: true, environment: env.ENVIRONMENT })
    }
    if (pathname === '/api/todos') {
      if (request.method === 'GET') return listTodos(request, env)
      if (request.method === 'POST') return createTodo(request, env)
      return json({ error: { code: 'method_not_allowed' } }, 405, { Allow: 'GET, POST' })
    }
    return json({ error: { code: 'not_found' } }, 404)
  },
} satisfies ExportedHandler<Env>
