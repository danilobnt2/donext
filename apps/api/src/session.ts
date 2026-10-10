/**
 * Guest sessions. Until sign-in exists, the first write from a browser creates
 * a guest user and an opaque session cookie; sign-in will later attach an email
 * or passkey to that same user.
 */
export const SESSION_COOKIE = '__Host-dn_session'
const SESSION_TTL_DAYS = 400

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

export async function findSessionUser(request: Request, db: D1Database): Promise<string | null> {
  const token = readCookie(request, SESSION_COOKIE)
  if (!token) return null
  const row = await db
    .prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(await sha256Hex(token), new Date().toISOString())
    .first<{ user_id: string }>()
  return row?.user_id ?? null
}

export async function createGuestSession(
  db: D1Database,
): Promise<{ userId: string; cookie: string }> {
  const userId = crypto.randomUUID()
  const token = randomToken()
  const now = new Date()
  const expires = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
  await db.batch([
    db
      .prepare('INSERT INTO users (id, email, created_at) VALUES (?, NULL, ?)')
      .bind(userId, now.toISOString()),
    db
      .prepare(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      )
      .bind(await sha256Hex(token), userId, now.toISOString(), expires.toISOString()),
  ])
  const cookie = `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}`
  return { userId, cookie }
}
