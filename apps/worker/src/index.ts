import type { ApiError, ApiErrorCode, AuthUser } from '@donext/shared';
import { SignJWT, base64url, jwtVerify } from 'jose';
import * as oidc from 'openid-client';

export { UserStore } from './user-store';

const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const OIDC_MAX_AGE = 10 * 60;
const DEV_SESSION_SECRET = 'dev-only-session-secret-32-bytes!';
const DEV_USER_RE = /^[a-z0-9_-]{1,32}$/i;

export type WorkerEnv = Env & { OIDC_CLIENT_SECRET?: string; SESSION_SECRET?: string };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/v1/health') {
      return Response.json({ status: 'ok', environment: env.ENVIRONMENT, version: env.GIT_SHA });
    }

    if (pathname === '/api/v1/me') {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const user = await getAuthenticatedUser(request, env);
      if (!user) return apiError(401, 'unauthorized', 'Sign in required.');
      return Response.json(user, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (pathname === '/api/v1/auth/login') {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      return handleLogin(url, env);
    }

    if (pathname === '/api/v1/auth/callback') {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      return handleCallback(request, url, env);
    }

    if (pathname === '/api/v1/auth/logout') {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      if (!isSameOrigin(request, url)) return new Response('Forbidden.', { status: 403 });
      return new Response(null, {
        status: 204,
        headers: { 'Set-Cookie': setCookie('session', '', url, 0) },
      });
    }

    if (pathname === '/api/v1/sync') {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      if (!isSameOrigin(request, url)) return new Response('Forbidden.', { status: 403 });
      const user = await getAuthenticatedUser(request, env);
      if (!user) return apiError(401, 'unauthorized', 'Sign in required.');
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade.', { status: 426 });
      }
      return env.USER_STORE.getByName(user.id).fetch(request);
    }

    if (pathname === '/api/v1/board') {
      if (request.method !== 'DELETE') return methodNotAllowed('DELETE');
      if (!isSameOrigin(request, url)) return new Response('Forbidden.', { status: 403 });
      const user = await getAuthenticatedUser(request, env);
      if (!user) return apiError(401, 'unauthorized', 'Sign in required.');
      return Response.json(await env.USER_STORE.getByName(user.id).resetBoard());
    }

    return apiError(404, 'not_found', 'No such endpoint.');
  },
} satisfies ExportedHandler<WorkerEnv>;

async function handleLogin(url: URL, env: WorkerEnv): Promise<Response> {
  const key = sessionKey(env);
  if (!key) return new Response('SESSION_SECRET is not configured.', { status: 500 });

  if (!env.OIDC_ISSUER && env.ENVIRONMENT === 'development') {
    const raw = url.searchParams.get('as') ?? 'dev';
    const alias = DEV_USER_RE.test(raw) ? raw.toLowerCase() : 'dev';
    const token = await signSession(
      {
        id: `dev:${alias}`,
        email: `${alias}@localhost`,
        name: alias === 'dev' ? 'Local User' : alias,
      },
      key,
    );
    return redirect('/', [setCookie('session', token, url, SESSION_MAX_AGE)]);
  }

  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID) {
    return new Response('OIDC is not configured.', { status: 500 });
  }

  const config = await discoverOidc(env);
  const state = oidc.randomState();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const redirectTo = oidc.buildAuthorizationUrl(config, {
    redirect_uri: `${url.origin}/api/v1/auth/callback`,
    scope: 'openid email profile',
    state,
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
  });
  return redirect(redirectTo.href, [
    setCookie('oidc', `${state}:${codeVerifier}`, url, OIDC_MAX_AGE),
  ]);
}

async function handleCallback(request: Request, url: URL, env: WorkerEnv): Promise<Response> {
  const clearOidc = setCookie('oidc', '', url, 0);
  if (url.searchParams.has('error')) return redirect('/', [clearOidc]);

  const key = sessionKey(env);
  if (!key || !env.OIDC_ISSUER || !env.OIDC_CLIENT_ID) {
    return new Response('Auth is not configured.', { status: 500 });
  }

  const [expectedState = '', codeVerifier = ''] = (
    readCookie(request, cookieName('oidc', url)) ?? ''
  ).split(':');
  if (
    !url.searchParams.get('code') ||
    !expectedState ||
    !codeVerifier ||
    url.searchParams.get('state') !== expectedState
  ) {
    return apiError(400, 'bad_request', 'Invalid OAuth callback state.', [clearOidc]);
  }

  try {
    const config = await discoverOidc(env);
    const tokens = await oidc.authorizationCodeGrant(config, url, {
      pkceCodeVerifier: codeVerifier,
      expectedState,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error('Missing ID token claims.');
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${claims.iss}\n${claims.sub}`),
    );
    const email = typeof claims.email === 'string' ? claims.email : '';
    const name = (typeof claims.name === 'string' && claims.name.trim()) || email || 'User';
    const token = await signSession(
      { id: base64url.encode(new Uint8Array(digest)), email, name },
      key,
    );
    return redirect('/', [clearOidc, setCookie('session', token, url, SESSION_MAX_AGE)]);
  } catch {
    return apiError(401, 'unauthorized', 'Authentication failed.', [clearOidc]);
  }
}

function discoverOidc(env: WorkerEnv): Promise<oidc.Configuration> {
  return oidc.discovery(
    new URL(env.OIDC_ISSUER),
    env.OIDC_CLIENT_ID,
    env.OIDC_CLIENT_SECRET || undefined,
    undefined,
    { execute: [oidc.enableNonRepudiationChecks] },
  );
}

function sessionKey(env: WorkerEnv): Uint8Array | null {
  const secret =
    env.SESSION_SECRET || (env.ENVIRONMENT === 'development' ? DEV_SESSION_SECRET : '');
  return secret.length >= 32 ? new TextEncoder().encode(secret) : null;
}

function signSession(user: AuthUser, key: Uint8Array): Promise<string> {
  return new SignJWT({ email: user.email, name: user.name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(key);
}

async function getAuthenticatedUser(request: Request, env: WorkerEnv): Promise<AuthUser | null> {
  const key = sessionKey(env);
  const token = readCookie(request, cookieName('session', new URL(request.url)));
  if (!key || !token) return null;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.email !== 'string' ||
      typeof payload.name !== 'string'
    ) {
      return null;
    }
    return { id: payload.sub, email: payload.email, name: payload.name };
  } catch {
    return null;
  }
}

function isSameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get('Origin');
  return origin === null || origin === url.origin;
}

function cookieName(base: string, url: URL): string {
  return url.protocol === 'https:' ? `__Host-${base}` : base;
}

function setCookie(base: string, value: string, url: URL, maxAge: number): string {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${cookieName(base, url)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { Allow: allow } });
}

function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  cookies: string[] = [],
): Response {
  const body: ApiError = { error: { code, message } };
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}
