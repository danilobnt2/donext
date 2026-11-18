import * as Automerge from '@automerge/automerge';
import {
  addTodo,
  decodeFrame,
  encodeFrame,
  listTodos,
  type AuthUser,
  type BoardDoc,
} from '@donext/shared';
import { env, SELF } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import * as oidc from 'openid-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

let userSeq = 0;

async function devSignIn(alias: string = `u${++userSeq}`): Promise<string> {
  const res = await SELF.fetch(`http://example.com/api/v1/auth/login?as=${alias}`, {
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  const cookie = (res.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
  expect(cookie).toMatch(/^session=.+/);
  return cookie;
}

class Peer {
  docId = '';
  doc: Automerge.Doc<BoardDoc> | null = null;
  syncState = Automerge.initSyncState();
  resets = 0;
  private waiters: Array<() => void> = [];
  private chain = Promise.resolve();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const data = event.data as ArrayBuffer | Blob;
      this.chain = this.chain.then(async () => {
        const buf = data instanceof Blob ? await data.arrayBuffer() : data;
        const frame = decodeFrame(new Uint8Array(buf));
        if (!frame) return;
        if (frame.kind === 'reset') {
          this.resets++;
          this.docId = frame.docId;
          this.doc = Automerge.load<BoardDoc>(frame.data);
          this.syncState = Automerge.initSyncState();
          this.flush();
        } else if (this.doc && frame.docId === this.docId) {
          [this.doc, this.syncState] = Automerge.receiveSyncMessage(
            this.doc,
            this.syncState,
            frame.data,
          );
          this.flush();
        }
        for (const w of this.waiters.splice(0)) w();
      });
    });
  }

  static async connect(
    cookie: string,
    cached?: { docId: string; doc: Automerge.Doc<BoardDoc> },
  ): Promise<Peer> {
    const res = await SELF.fetch('http://example.com/api/v1/sync', {
      headers: { Upgrade: 'websocket', Cookie: cookie },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const peer = new Peer(ws);
    if (cached) {
      peer.docId = cached.docId;
      peer.doc = cached.doc;
      peer.flush();
    } else {
      ws.send(encodeFrame('sync', ''));
      await peer.until(() => peer.doc !== null);
    }
    return peer;
  }

  flush(): void {
    if (!this.doc) return;
    const [next, msg] = Automerge.generateSyncMessage(this.doc, this.syncState);
    this.syncState = next;
    if (msg) this.ws.send(encodeFrame('sync', this.docId, msg));
  }

  titles(): string[] {
    return this.doc ? listTodos(this.doc).map((t) => t.title) : [];
  }

  async until(pred: () => boolean): Promise<void> {
    while (!pred()) await new Promise<void>((r) => this.waiters.push(r));
  }

  close(): void {
    this.ws.close(1000);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Worker authentication, sync and gatekeeper', () => {
  it('serves /api/v1/health publicly and requires sign-in on /api/v1/me and /api/v1/sync', async () => {
    const health = await SELF.fetch('http://example.com/api/v1/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok' });

    expect((await SELF.fetch('http://example.com/api/v1/me')).status).toBe(401);
    expect(
      (await SELF.fetch('http://example.com/api/v1/sync', { headers: { Upgrade: 'websocket' } }))
        .status,
    ).toBe(401);
    expect((await SELF.fetch('http://example.com/api/v1/board', { method: 'DELETE' })).status).toBe(
      401,
    );
  });

  it('completes OIDC + PKCE sign-in, signs session cookies, and clears them on logout', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const publicJwk = await exportJWK(publicKey);
    const kid = 'test-es256-key';
    const issuer = 'https://auth.orben.dev';
    const clientId = 'donext';

    let capturedChallenge = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
          end_session_endpoint: `${issuer}/logout`,
          id_token_signing_alg_values_supported: ['ES256'],
        });
      }
      if (url === `${issuer}/.well-known/jwks.json`) {
        return Response.json({ keys: [{ ...publicJwk, kid, use: 'sig', alg: 'ES256' }] });
      }
      if (url === `${issuer}/token`) {
        const body =
          init?.body instanceof URLSearchParams
            ? init.body
            : new URLSearchParams(String(init?.body ?? ''));
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('client_id')).toBe(clientId);
        expect(body.get('redirect_uri')).toBe('https://donext.orben.dev/api/v1/auth/callback');
        expect(await oidc.calculatePKCECodeChallenge(body.get('code_verifier') ?? '')).toBe(
          capturedChallenge,
        );

        const idToken = await new SignJWT({ email: 'danilo@orben.dev', name: 'Danilo' })
          .setProtectedHeader({ alg: 'ES256', kid })
          .setIssuer(issuer)
          .setSubject('usr_danilo')
          .setAudience(clientId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        return Response.json({ token_type: 'Bearer', access_token: idToken, id_token: idToken });
      }
      throw new Error(`Unexpected outbound fetch: ${url}`);
    });

    const prodEnv = {
      ...env,
      ENVIRONMENT: 'production',
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: clientId,
      SESSION_SECRET: 'prod-test-session-secret-at-least-32-bytes!',
    };

    const loginRes = await worker.fetch(
      new Request('https://donext.orben.dev/api/v1/auth/login'),
      prodEnv,
    );
    expect(loginRes.status).toBe(302);
    const redirectUrl = new URL(loginRes.headers.get('Location')!);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(`${issuer}/authorize`);
    expect(redirectUrl.searchParams.get('prompt')).toBe('select_account');
    capturedChallenge = redirectUrl.searchParams.get('code_challenge')!;
    const state = redirectUrl.searchParams.get('state')!;
    const oidcCookie = loginRes.headers.get('Set-Cookie')!.split(';')[0]!;

    const badStateRes = await worker.fetch(
      new Request('https://donext.orben.dev/api/v1/auth/callback?code=c1&state=wrong', {
        headers: { Cookie: oidcCookie },
      }),
      prodEnv,
    );
    expect(badStateRes.status).toBe(400);

    const cbRes = await worker.fetch(
      new Request(`https://donext.orben.dev/api/v1/auth/callback?code=c1&state=${state}`, {
        headers: { Cookie: oidcCookie },
      }),
      prodEnv,
    );
    expect(cbRes.status).toBe(302);
    const sessionCookie = cbRes.headers
      .getSetCookie()
      .find((c) => c.startsWith('__Host-session='))!
      .split(';')[0]!;

    const meRes = await worker.fetch(
      new Request('https://donext.orben.dev/api/v1/me', { headers: { Cookie: sessionCookie } }),
      prodEnv,
    );
    expect(meRes.status).toBe(200);
    expect((await meRes.json()) as AuthUser).toMatchObject({
      email: 'danilo@orben.dev',
      name: 'Danilo',
    });

    const wrongKeyRes = await worker.fetch(
      new Request('https://donext.orben.dev/api/v1/me', { headers: { Cookie: sessionCookie } }),
      { ...prodEnv, SESSION_SECRET: 'different-session-secret-at-least-32-bytes!' },
    );
    expect(wrongKeyRes.status).toBe(401);

    const crossOriginLogout = await worker.fetch(
      new Request('https://donext.orben.dev/api/v1/auth/logout', {
        method: 'POST',
        headers: { Cookie: sessionCookie, Origin: 'https://evil.orben.dev' },
      }),
      prodEnv,
    );
    expect(crossOriginLogout.status).toBe(403);

    const logoutRes = await worker.fetch(
      new Request('https://donext.orben.dev/api/v1/auth/logout', {
        method: 'POST',
        headers: { Cookie: sessionCookie, Origin: 'https://donext.orben.dev' },
      }),
      prodEnv,
    );
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.headers.get('Set-Cookie')).toContain('__Host-session=;');
    expect(logoutRes.headers.get('Set-Cookie')).toContain('Max-Age=0');
    const { logoutUrl } = (await logoutRes.json()) as { logoutUrl: string };
    const endUrl = new URL(logoutUrl);
    expect(endUrl.origin + endUrl.pathname).toBe(`${issuer}/logout`);
    expect(endUrl.searchParams.get('client_id')).toBe('donext');
    expect(endUrl.searchParams.get('post_logout_redirect_uri')).toBe('https://donext.orben.dev/');
    expect(endUrl.searchParams.get('return_to')).toBe('https://donext.orben.dev/');
  });

  it('isolates boards strictly per authenticated user', async () => {
    const aliceCookie = await devSignIn('alice');
    const bobCookie = await devSignIn('bob');

    const alice = await Peer.connect(aliceCookie);
    const bob = await Peer.connect(bobCookie);

    const added = addTodo(alice.doc!, 'Alice secret goal', 1000);
    if (added.ok) alice.doc = added.doc;
    alice.flush();

    const alicePeer2 = await Peer.connect(aliceCookie);
    await alicePeer2.until(() => alicePeer2.titles().includes('Alice secret goal'));
    expect(bob.titles()).toEqual([]);

    const bobAdded = addTodo(bob.doc!, 'Bob separate goal', 2000);
    if (bobAdded.ok) bob.doc = bobAdded.doc;
    bob.flush();

    const bobPeer2 = await Peer.connect(bobCookie);
    await bobPeer2.until(() => bobPeer2.titles().includes('Bob separate goal'));
    expect(alicePeer2.titles()).toEqual(['Alice secret goal']);

    alice.close();
    alicePeer2.close();
    bob.close();
    bobPeer2.close();
  });

  it('syncs live across connected peers and merges offline edits on reconnect', async () => {
    const cookie = await devSignIn();
    const a = await Peer.connect(cookie);
    const b = await Peer.connect(cookie);

    const added = addTodo(a.doc!, 'Buy coffee', 1000);
    if (added.ok) a.doc = added.doc;
    a.flush();
    await b.until(() => b.titles().includes('Buy coffee'));

    const cachedDocId = b.docId;
    let offlineDoc = Automerge.clone(b.doc!);
    b.close();
    const offAdd = addTodo(offlineDoc, 'Offline task', 2000);
    if (offAdd.ok) offlineDoc = offAdd.doc;

    const onlineAdd = addTodo(a.doc!, 'Online task', 3000);
    if (onlineAdd.ok) a.doc = onlineAdd.doc;
    a.flush();

    const b2 = await Peer.connect(cookie, { docId: cachedDocId, doc: offlineDoc });
    await a.until(() => a.titles().length === 3);
    await b2.until(() => b2.titles().length === 3);
    expect(a.titles()).toEqual(['Online task', 'Offline task', 'Buy coffee']);
    expect(b2.titles()).toEqual(['Online task', 'Offline task', 'Buy coffee']);
    a.close();
    b2.close();
  });

  it('rejects invalid sync changes and resets the offending peer to canonical state', async () => {
    const cookie = await devSignIn();
    const honest = await Peer.connect(cookie);
    const ok = addTodo(honest.doc!, 'Keep me');
    if (ok.ok) honest.doc = ok.doc;
    honest.flush();

    const rogue = await Peer.connect(cookie);
    await rogue.until(() => rogue.titles().includes('Keep me'));
    const beforeResets = rogue.resets;

    rogue.doc = Automerge.change(Automerge.clone(rogue.doc!), (d) => {
      d.todos['01ARZ3NDEKTSV4RRFFQ69G5FAV'] = {
        id: new Automerge.ImmutableString('01ARZ3NDEKTSV4RRFFQ69G5FAV'),
        title: new Automerge.ImmutableString(''),
        state: new Automerge.ImmutableString('new'),
        createdAt: 1,
      };
    });
    rogue.flush();

    await rogue.until(() => rogue.resets > beforeResets);
    expect(rogue.titles()).toEqual(['Keep me']);
    expect(honest.titles()).toEqual(['Keep me']);
    honest.close();
    rogue.close();
  });

  it('hard-deletes history and rotates docId on DELETE /api/v1/board for that user only', async () => {
    const cookie = await devSignIn();
    const otherCookie = await devSignIn();
    const peer = await Peer.connect(cookie);
    const bystander = await Peer.connect(otherCookie);
    const prevDocId = peer.docId;

    const ok = addTodo(peer.doc!, 'Secret');
    if (ok.ok) peer.doc = ok.doc;
    peer.flush();
    const ok2 = addTodo(bystander.doc!, 'Untouched');
    if (ok2.ok) bystander.doc = ok2.doc;
    bystander.flush();

    const other = await Peer.connect(cookie);
    await other.until(() => other.titles().includes('Secret'));

    const res = await SELF.fetch('http://example.com/api/v1/board', {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    const { docId } = (await res.json()) as { docId: string };
    expect(docId).not.toBe(prevDocId);

    await peer.until(() => peer.docId === docId);
    expect(peer.titles()).toEqual([]);
    expect(Automerge.getHistory(peer.doc!)).toHaveLength(1);
    expect(bystander.titles()).toEqual(['Untouched']);
    peer.close();
    other.close();
    bystander.close();
  });
});
