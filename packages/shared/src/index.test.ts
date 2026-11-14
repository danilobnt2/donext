import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import {
  TITLE_MAX_LENGTH,
  addTodo,
  applyValidatedSync,
  checkTitle,
  createBoard,
  decodeFrame,
  encodeFrame,
  listTodos,
  type BoardDoc,
} from './index';

function syncToServer(
  client: Automerge.Doc<BoardDoc>,
  server: Automerge.Doc<BoardDoc>,
  docId: string,
) {
  let cDoc = Automerge.clone(client);
  let sDoc = server;
  let cSync = Automerge.initSyncState();
  let sSync = Automerge.initSyncState();
  for (let i = 0; i < 6; i++) {
    let msg: Uint8Array | null;
    [cSync, msg] = Automerge.generateSyncMessage(cDoc, cSync);
    if (msg) {
      const res = applyValidatedSync(sDoc, docId, sSync, msg);
      if (!res) return null;
      sDoc = res.doc;
      sSync = res.syncState;
    }
    let reply: Uint8Array | null;
    [sSync, reply] = Automerge.generateSyncMessage(sDoc, sSync);
    if (reply) [cDoc, cSync] = Automerge.receiveSyncMessage(cDoc, cSync, reply);
    if (!msg && !reply) break;
  }
  return sDoc;
}

describe('checkTitle', () => {
  it('trims valid titles and enforces length bounds', () => {
    expect(checkTitle('  Buy milk  ')).toEqual({ ok: true, title: 'Buy milk' });
    expect(checkTitle('   ').ok).toBe(false);
    expect(checkTitle('a'.repeat(TITLE_MAX_LENGTH)).ok).toBe(true);
    expect(checkTitle('a'.repeat(TITLE_MAX_LENGTH + 1)).ok).toBe(false);
  });
});

describe('Automerge board and gatekeeper', () => {
  it('adds To-Dos newest first and merges valid client edits', () => {
    const { docId, doc: server } = createBoard();
    let client = Automerge.load<BoardDoc>(Automerge.save(server));
    const r1 = addTodo(client, 'First', 1000);
    const r2 = r1.ok ? addTodo(r1.doc, 'Second', 1000) : r1;
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    client = r2.doc;

    const merged = syncToServer(client, server, docId);
    expect(merged && listTodos(merged).map((t) => t.title)).toEqual(['Second', 'First']);
  });

  it('rejects tampered titles, wrong docId, and conflicting fields without mutating canonical doc', () => {
    const { docId, doc: server } = createBoard();
    const okPeer = addTodo(Automerge.load<BoardDoc>(Automerge.save(server)), 'Valid');
    expect(okPeer.ok).toBe(true);
    if (!okPeer.ok) return;
    const canonical = syncToServer(okPeer.doc, server, docId)!;

    const badTitle = Automerge.change(Automerge.load<BoardDoc>(Automerge.save(canonical)), (d) => {
      d.todos['01ARZ3NDEKTSV4RRFFQ69G5FAV'] = {
        id: new Automerge.ImmutableString('01ARZ3NDEKTSV4RRFFQ69G5FAV'),
        title: new Automerge.ImmutableString('   '),
        state: new Automerge.ImmutableString('new'),
        createdAt: 1,
      };
    });
    expect(syncToServer(badTitle, canonical, docId)).toBeNull();

    const otherBoard = createBoard();
    const wrongEpoch = addTodo(otherBoard.doc, 'Replay');
    if (wrongEpoch.ok) expect(syncToServer(wrongEpoch.doc, canonical, docId)).toBeNull();

    expect(listTodos(canonical).map((t) => t.title)).toEqual(['Valid']);
  });

  it('round-trips sync and reset frames', () => {
    const frame = decodeFrame(
      encodeFrame('sync', '01ARZ3NDEKTSV4RRFFQ69G5FAV', new Uint8Array([1, 2])),
    );
    expect(frame).toEqual({
      kind: 'sync',
      docId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      data: new Uint8Array([1, 2]),
    });
    expect(decodeFrame(new Uint8Array([1, 2]))).toBeNull();
  });
});
