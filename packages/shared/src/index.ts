import * as Automerge from '@automerge/automerge/slim';
import { monotonicFactory } from 'ulid';

/** Longest To-Do title accepted, in characters (Unicode code points). */
export const TITLE_MAX_LENGTH = 500;

/** Most To-Dos one board can hold. Becomes the per-user limit once sign-in exists. */
export const TODO_LIMIT = 10_000;

/** Largest WebSocket sync frame accepted, in bytes. */
export const MAX_FRAME_BYTES = 128 * 1024;

export type TodoState = 'new' | 'active' | 'pending' | 'done';

export interface Todo {
  id: string;
  title: string;
  state: TodoState;
  createdAt: string;
}

export type ApiErrorCode = 'not_found';

export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}

export type StoredTodo = {
  id: Automerge.ImmutableString;
  title: Automerge.ImmutableString;
  state: Automerge.ImmutableString;
  createdAt: number;
};

export type BoardDoc = {
  docId: Automerge.ImmutableString;
  todos: Record<string, StoredTodo>;
};

export type TitleCheck = { ok: true; title: string } | { ok: false; message: string };

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const STATES = new Set<string>(['new', 'active', 'pending', 'done']);
const nextUlid = monotonicFactory();

/** Trims the title and checks it is non-empty and within TITLE_MAX_LENGTH. */
export function checkTitle(input: unknown): TitleCheck {
  if (typeof input !== 'string') return { ok: false, message: 'Title must be text.' };
  const title = input.trim();
  if (title.length === 0) return { ok: false, message: 'Title is required.' };
  if ([...title].length > TITLE_MAX_LENGTH) {
    return { ok: false, message: `Title must be at most ${TITLE_MAX_LENGTH} characters.` };
  }
  return { ok: true, title };
}

/** Creates a fresh, history-free Automerge board document with a new `docId`. */
export function createBoard(docId: string = nextUlid()): {
  docId: string;
  doc: Automerge.Doc<BoardDoc>;
} {
  const doc = Automerge.from<BoardDoc>({
    docId: new Automerge.ImmutableString(docId),
    todos: {},
  });
  return { docId, doc };
}

/** Reads every To-Do from the document, newest first. */
export function listTodos(doc: Automerge.Doc<BoardDoc>): Todo[] {
  return Object.values(doc.todos)
    .sort((a, b) => (a.id.val < b.id.val ? 1 : a.id.val > b.id.val ? -1 : 0))
    .map((item) => ({
      id: item.id.val,
      title: item.title.val,
      state: item.state.val as TodoState,
      createdAt: new Date(item.createdAt).toISOString(),
    }));
}

/** Validates locally and returns a cloned document with the new To-Do appended. */
export function addTodo(
  doc: Automerge.Doc<BoardDoc>,
  inputTitle: unknown,
  now: number = Date.now(),
): { ok: true; doc: Automerge.Doc<BoardDoc> } | { ok: false; message: string } {
  const checked = checkTitle(inputTitle);
  if (!checked.ok) return checked;
  if (Object.keys(doc.todos).length >= TODO_LIMIT) {
    return { ok: false, message: 'This board is full.' };
  }
  const id = nextUlid(now);
  const nextDoc = Automerge.change(Automerge.clone(doc), (draft) => {
    draft.todos[id] = {
      id: new Automerge.ImmutableString(id),
      title: new Automerge.ImmutableString(checked.title),
      state: new Automerge.ImmutableString('new'),
      createdAt: now,
    };
  });
  return { ok: true, doc: nextDoc };
}

/** Checks that a candidate Automerge document satisfies the board schema, field rules and cap. */
export function isValidBoardDoc(doc: Automerge.Doc<BoardDoc>, expectedDocId: string): boolean {
  const raw = doc as Record<string, unknown>;
  if (Object.keys(raw).length !== 2) return false;
  if (Automerge.getConflicts(raw, 'docId') || Automerge.getConflicts(raw, 'todos')) return false;
  if (!Automerge.isImmutableString(raw.docId) || raw.docId.val !== expectedDocId) return false;
  if (!isPlainRecord(raw.todos)) return false;

  const entries = Object.entries(raw.todos);
  if (entries.length > TODO_LIMIT) return false;

  for (const [key, item] of entries) {
    if (!ULID_RE.test(key) || !isPlainRecord(item)) return false;
    const keys = Object.keys(item);
    if (keys.length !== 4 || keys.some((k) => Automerge.getConflicts(item, k) !== undefined)) {
      return false;
    }
    if (!Automerge.isImmutableString(item.id) || item.id.val !== key) return false;
    if (!Automerge.isImmutableString(item.state) || !STATES.has(item.state.val)) return false;
    if (!Automerge.isImmutableString(item.title)) return false;
    const title = checkTitle(item.title.val);
    if (!title.ok || title.title !== item.title.val) return false;
    if (typeof item.createdAt !== 'number' || !Number.isSafeInteger(item.createdAt)) return false;
  }
  return true;
}

/** Applies a sync message to a temporary copy and returns the new state only if valid. */
export function applyValidatedSync(
  doc: Automerge.Doc<BoardDoc>,
  docId: string,
  syncState: Automerge.SyncState,
  message: Uint8Array,
): { doc: Automerge.Doc<BoardDoc>; syncState: Automerge.SyncState; changed: boolean } | null {
  try {
    const prevHeads = Automerge.getHeads(doc);
    const clonedSync = Automerge.decodeSyncState(Automerge.encodeSyncState(syncState));
    const [nextDoc, nextSync] = Automerge.receiveSyncMessage(
      Automerge.clone(doc),
      clonedSync,
      message,
    );
    if (!isValidBoardDoc(nextDoc, docId)) return null;
    const changed = !headsEqual(prevHeads, Automerge.getHeads(nextDoc));
    return { doc: changed ? nextDoc : doc, syncState: nextSync, changed };
  } catch {
    return null;
  }
}

export function headsEqual(a: Automerge.Heads, b: Automerge.Heads): boolean {
  return a.length === b.length && a.every((h, i) => h === b[i]);
}

export type Frame = { kind: 'sync' | 'reset'; docId: string; data: Uint8Array };

export function encodeFrame(kind: Frame['kind'], docId: string, data?: Uint8Array): Uint8Array {
  const prefix = `${kind}:${docId}\n`;
  const out = new Uint8Array(prefix.length + (data?.length ?? 0));
  for (let i = 0; i < prefix.length; i++) out[i] = prefix.charCodeAt(i);
  if (data) out.set(data, prefix.length);
  return out;
}

export function decodeFrame(bytes: Uint8Array): Frame | null {
  const nl = bytes.indexOf(10);
  if (nl < 5 || nl > 64 || bytes.byteLength > MAX_FRAME_BYTES) return null;
  const header = String.fromCharCode(...bytes.subarray(0, nl));
  const sep = header.indexOf(':');
  const kind = header.slice(0, sep);
  if (kind !== 'sync' && kind !== 'reset') return null;
  return { kind, docId: header.slice(sep + 1), data: bytes.subarray(nl + 1) };
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
