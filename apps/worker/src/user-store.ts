import * as Automerge from '@automerge/automerge';
import {
  applyValidatedSync,
  createBoard,
  decodeFrame,
  encodeFrame,
  type BoardDoc,
} from '@donext/shared';
import { DurableObject } from 'cloudflare:workers';

type BoardRow = { doc_id: string; snapshot: ArrayBuffer };

/**
 * Holds the canonical Automerge document in Durable Object SQLite storage and validates every
 * incoming WebSocket sync frame on a clone before accepting and broadcasting it.
 */
export class UserStore extends DurableObject<Env> {
  private docId!: string;
  private doc!: Automerge.Doc<BoardDoc>;
  private readonly syncStates = new WeakMap<WebSocket, Automerge.SyncState>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec('DROP TABLE IF EXISTS work_items');
      sql.exec('DROP TABLE IF EXISTS schema_migrations');
      sql.exec('DROP TABLE IF EXISTS __drizzle_migrations');
      sql.exec('CREATE TABLE IF NOT EXISTS board (doc_id TEXT NOT NULL, snapshot BLOB NOT NULL)');

      const row = sql.exec<BoardRow>('SELECT doc_id, snapshot FROM board LIMIT 1').toArray()[0];
      if (row) {
        this.docId = row.doc_id;
        this.doc = Automerge.load<BoardDoc>(new Uint8Array(row.snapshot));
      } else {
        this.writeFreshBoard();
      }
    });
  }

  override fetch(): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    this.syncStates.set(server, Automerge.initSyncState());
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, raw: ArrayBuffer | string): void {
    if (typeof raw === 'string') return this.sendReset(ws);
    const frame = decodeFrame(new Uint8Array(raw));
    if (!frame || frame.kind !== 'sync') return this.sendReset(ws);
    if (frame.docId !== this.docId) return this.sendReset(ws);

    let syncState = this.syncStates.get(ws) ?? Automerge.initSyncState();
    if (frame.data.byteLength > 0) {
      const res = applyValidatedSync(this.doc, this.docId, syncState, frame.data);
      if (!res) return this.sendReset(ws);
      syncState = res.syncState;
      if (res.changed) {
        this.doc = res.doc;
        this.persist();
        for (const peer of this.ctx.getWebSockets()) {
          if (peer !== ws) this.flush(peer, this.syncStates.get(peer) ?? Automerge.initSyncState());
        }
      }
    }
    this.flush(ws, syncState);
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    if (code === 1000 || (code >= 3000 && code <= 4999)) ws.close(code, reason);
    else ws.close();
  }

  /** Wipes the active document and its CRDT history, rotating `docId` for every device. */
  resetBoard(): { docId: string } {
    const snapshot = this.writeFreshBoard();
    const reset = encodeFrame('reset', this.docId, snapshot);
    for (const peer of this.ctx.getWebSockets()) {
      this.syncStates.set(peer, Automerge.initSyncState());
      this.send(peer, reset);
    }
    return { docId: this.docId };
  }

  private writeFreshBoard(): Uint8Array {
    const fresh = createBoard();
    this.docId = fresh.docId;
    this.doc = fresh.doc;
    return this.persist();
  }

  private persist(): Uint8Array {
    const snapshot = Automerge.save(this.doc);
    const buf = snapshot.buffer.slice(
      snapshot.byteOffset,
      snapshot.byteOffset + snapshot.byteLength,
    );
    this.ctx.storage.sql.exec('DELETE FROM board');
    this.ctx.storage.sql.exec(
      'INSERT INTO board (doc_id, snapshot) VALUES (?, ?)',
      this.docId,
      buf,
    );
    return snapshot;
  }

  private flush(ws: WebSocket, syncState: Automerge.SyncState): void {
    const [nextSync, reply] = Automerge.generateSyncMessage(this.doc, syncState);
    this.syncStates.set(ws, nextSync);
    if (reply) this.send(ws, encodeFrame('sync', this.docId, reply));
  }

  private sendReset(ws: WebSocket): void {
    this.syncStates.set(ws, Automerge.initSyncState());
    this.send(ws, encodeFrame('reset', this.docId, Automerge.save(this.doc)));
  }

  private send(ws: WebSocket, bytes: Uint8Array): void {
    try {
      ws.send(bytes);
    } catch {
      // Closed sockets are cleaned up by the runtime.
    }
  }
}
