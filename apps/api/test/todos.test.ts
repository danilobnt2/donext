import { runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

const BASE = 'https://donext.test'
const ID_A = '01JA2B3C4D5E6F7G8H9JKMNPQR'
const ID_B = '01JA2B3C4D5E6F7G8H9JKMNPQS'

function post(body: unknown, cookie?: string) {
  return exports.default.fetch(`${BASE}/api/todos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  })
}

function list(cookie?: string) {
  return exports.default.fetch(`${BASE}/api/todos`, cookie ? { headers: { Cookie: cookie } } : {})
}

function sessionCookie(response: Response): string {
  const header = response.headers.get('Set-Cookie')
  expect(header).toMatch(/^__Host-dn_session=[\w-]+; Path=\/; Secure; HttpOnly; SameSite=Lax/)
  return (header as string).split(';')[0] as string
}

async function userIdFor(cookie: string): Promise<string> {
  const token = cookie.split('=')[1] as string
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const row = await env.DB.prepare('SELECT user_id FROM sessions WHERE token_hash = ?')
    .bind(hash)
    .first<{ user_id: string }>()
  return row?.user_id as string
}

describe('POST /api/todos', () => {
  it('creates a New To-Do and a guest session on first write', async () => {
    const response = await post({
      id: ID_A,
      title: 'Plan dad’s 70th birthday',
      notes: 'Ask mum first',
      dueDate: '2026-10-24',
    })
    expect(response.status).toBe(201)
    const { todo } = await response.json<{ todo: Record<string, unknown> }>()
    expect(todo).toMatchObject({
      id: ID_A,
      title: 'Plan dad’s 70th birthday',
      notes: 'Ask mum first',
      dueDate: '2026-10-24',
      state: 'new',
      rev: 1,
      doneAt: null,
    })

    const cookie = sessionCookie(response)
    const { todos } = await (await list(cookie)).json<{ todos: { id: string }[] }>()
    expect(todos.map((t) => t.id)).toEqual([ID_A])
  })

  it('writes the first revision to the append-only log', async () => {
    const cookie = sessionCookie(await post({ id: ID_A, title: 'Cut the lawn' }))
    const stub = env.USER_STORE.get(env.USER_STORE.idFromName(await userIdFor(cookie)))

    const revisions = await runInDurableObject(stub, (_, state) =>
      state.storage.sql.exec('SELECT * FROM work_item_revisions').toArray(),
    )
    expect(revisions).toHaveLength(1)
    expect(revisions[0]).toMatchObject({ item_id: ID_A, rev: 1, source: 'app', seq: 1 })
    expect(JSON.parse(revisions[0]?.snapshot as string)).toMatchObject({ title: 'Cut the lawn' })
  })

  it('is idempotent when the client retries the same id', async () => {
    const cookie = sessionCookie(await post({ id: ID_A, title: 'Cut the lawn' }))
    const retry = await post({ id: ID_A, title: 'Cut the lawn' }, cookie)
    expect(retry.status).toBe(200)
    expect(retry.headers.get('Set-Cookie')).toBeNull()
    const { todos } = await (await list(cookie)).json<{ todos: unknown[] }>()
    expect(todos).toHaveLength(1)
  })

  it('keeps each user’s To-Dos separate', async () => {
    const alice = sessionCookie(await post({ id: ID_A, title: 'Alice' }))
    const bob = sessionCookie(await post({ id: ID_B, title: 'Bob' }))
    const aliceTodos = await (await list(alice)).json<{ todos: { title: string }[] }>()
    const bobTodos = await (await list(bob)).json<{ todos: { title: string }[] }>()
    expect(aliceTodos.todos.map((t) => t.title)).toEqual(['Alice'])
    expect(bobTodos.todos.map((t) => t.title)).toEqual(['Bob'])
  })

  it('rejects an invalid To-Do with field issues', async () => {
    const response = await post({ id: ID_A, title: '  ', dueDate: '2026-02-30' })
    expect(response.status).toBe(400)
    const { error } = await response.json<{
      error: { code: string; issues: { path: string }[] }
    }>()
    expect(error.code).toBe('invalid')
    expect(error.issues.map((i) => i.path).sort()).toEqual(['dueDate', 'title'])
  })

  it('requires a JSON body', async () => {
    const response = await exports.default.fetch(`${BASE}/api/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'title=x',
    })
    expect(response.status).toBe(415)
  })
})

describe('GET /api/todos', () => {
  it('returns an empty board without creating a session', async () => {
    const response = await list()
    expect(response.status).toBe(200)
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(await response.json()).toEqual({ todos: [] })
  })

  it('ignores an unknown session cookie', async () => {
    const response = await list('__Host-dn_session=forged')
    expect(await response.json()).toEqual({ todos: [] })
  })
})

describe('GET /api/health', () => {
  it('reports the environment', async () => {
    const response = await exports.default.fetch(`${BASE}/api/health`)
    expect(await response.json()).toEqual({ ok: true, environment: 'local' })
  })
})
