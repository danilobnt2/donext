import * as Automerge from '@automerge/automerge';
import { addTodo, decodeFrame, encodeFrame, listTodos, type BoardDoc } from '@donext/shared';
import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

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

  static async connect(cached?: { docId: string; doc: Automerge.Doc<BoardDoc> }): Promise<Peer> {
    const res = await SELF.fetch('http://example.com/api/v1/sync', {
      headers: { Upgrade: 'websocket' },
    });
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

beforeEach(async () => {
  await SELF.fetch('http://example.com/api/v1/board', { method: 'DELETE' });
});

describe('Worker sync and gatekeeper', () => {
  it('serves /api/v1/health', async () => {
    const res = await SELF.fetch('http://example.com/api/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  it('syncs live across connected peers and merges offline edits on reconnect', async () => {
    const a = await Peer.connect();
    const b = await Peer.connect();

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

    const b2 = await Peer.connect({ docId: cachedDocId, doc: offlineDoc });
    await a.until(() => a.titles().length === 3);
    await b2.until(() => b2.titles().length === 3);
    expect(a.titles()).toEqual(['Online task', 'Offline task', 'Buy coffee']);
    expect(b2.titles()).toEqual(['Online task', 'Offline task', 'Buy coffee']);
    a.close();
    b2.close();
  });

  it('rejects invalid sync changes and resets the offending peer to canonical state', async () => {
    const honest = await Peer.connect();
    const ok = addTodo(honest.doc!, 'Keep me');
    if (ok.ok) honest.doc = ok.doc;
    honest.flush();

    const rogue = await Peer.connect();
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

  it('hard-deletes history and rotates docId on DELETE /api/v1/board', async () => {
    const peer = await Peer.connect();
    const prevDocId = peer.docId;
    const ok = addTodo(peer.doc!, 'Secret');
    if (ok.ok) peer.doc = ok.doc;
    peer.flush();

    const other = await Peer.connect();
    await other.until(() => other.titles().includes('Secret'));

    const res = await SELF.fetch('http://example.com/api/v1/board', { method: 'DELETE' });
    const { docId } = (await res.json()) as { docId: string };
    expect(docId).not.toBe(prevDocId);

    await peer.until(() => peer.docId === docId);
    expect(peer.titles()).toEqual([]);
    expect(Automerge.getHistory(peer.doc!)).toHaveLength(1);
    peer.close();
    other.close();
  });
});
